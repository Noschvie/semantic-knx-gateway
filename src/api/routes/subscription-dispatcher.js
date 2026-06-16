// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../../utils/logger.js';
import { createHmac } from 'node:crypto';

/**
 * CallbackDispatcher
 *
 * Listens on stateEngine.eventBus ('datapoint:<id>') and sends
 * HTTP POST requests to all active callback subscriptions that
 * have subscribed to the changed datapoint.
 *
 * Error behaviour: fire & forget with logging to subscription_events.
 * No retry – failed deliveries are only logged.
 */
export class CallbackDispatcher {
    #telegramHandler = null;
    // Active listeners: datapointId → handler function
    // Required for clean unsubscribe on stop()
    // eslint-disable-next-line no-unused-private-class-members
    #listeners       = new Map();

    constructor(stateEngine, subscriptionStore) {
        this.logger      = createLogger('CallbackDispatcher');
        this.stateEngine = stateEngine;
        this.store       = subscriptionStore;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Starts the dispatcher.
     * Registers a generic 'telegram' listener on the EventBus –
     * this captures every datapoint change without needing a
     * separate listener per datapoint.
     */
    start() {
        this.#telegramHandler = (event) => this.#onTelegram(event);
        this.stateEngine.subscribe('telegram', this.#telegramHandler);
        this.logger.info('✅ CallbackDispatcher started');
    }

    /**
     * Stops the dispatcher and cleans up all listeners.
     */
    stop() {
        if (this.#telegramHandler) {
            this.stateEngine.unsubscribe('telegram', this.#telegramHandler);
            this.#telegramHandler = null;
        }
        this.logger.info('CallbackDispatcher stopped');
    }

    // ------------------------------------------------------------------
    // Internal Event Handling
    // ------------------------------------------------------------------

    /**
     * Called for every processed KNX telegram.
     * It looks up all active callback subscriptions for the datapoint
     * and dispatches asynchronously – without blocking the telegram
     * processing path.
     */
    async #onTelegram(event) {
        const { datapointId, ga, value, timestamp } = event;

        if (!datapointId) return;

        let subscriptions;
        try {
            subscriptions = await this.store.findActiveCallbacksByDatapointId(datapointId);
        } catch (err) {
            this.logger.error({ msg: 'Failed to query subscriptions for datapoint', datapointId, error: err.message });
            return;
        }

        if (subscriptions.length === 0) return;

        this.logger.debug({
            msg: `📤 Dispatching to ${subscriptions.length} subscriber(s)`,
            datapointId,
            ga,
        });

        // Fire all deliveries in parallel – a failure in one callback
        // does not block the others
        await Promise.allSettled(
            subscriptions.map(sub =>
                this.#deliver(sub, { datapointId, value, timestamp }),
            ),
        );
    }

    // ------------------------------------------------------------------
    // HTTP Delivery
    // ------------------------------------------------------------------

    /**
     * Sends a single callback request.
     * Body format: JSON:API-compliant notification object per KNX IoT Spec.
     *
     * @param {object} sub   Row from subscription_datapoints JOIN subscriptions
     * @param {object} event Datapoint event
     */
    async #deliver(sub, event) {
        const { id: subscriptionId, url, secret } = sub;
        const { datapointId, value, timestamp } = event;

        const payload = this.#buildPayload(datapointId, value, timestamp);
        const body    = JSON.stringify(payload);
        const date    = new Date().toUTCString();
        const headers = this.#buildHeaders(body, secret, url, date);

        const deliveredAt = new Date();
        let httpStatus    = null;
        let deliveryError = null;

        this.logger.debug({
            msg:            '→ Attempting callback delivery',
            subscriptionId,
            url,
            datapointId,
            payloadSize:    body.length,
            hasSecret:      !!secret,
        });

        try {
            const controller = new AbortController();
            const timeout    = setTimeout(() => controller.abort(), 10_000); // 10s timeout

            const response = await fetch(url, {
                method:  'POST',
                headers,
                body,
                signal:  controller.signal,
            });
            clearTimeout(timeout);

            httpStatus = response.status;

            if (!response.ok) {
                deliveryError = `HTTP ${response.status} ${response.statusText}`;
                this.logger.warn({
                    msg:            '⚠️  Callback delivery failed (non-2xx)',
                    subscriptionId,
                    url,
                    datapointId,
                    httpStatus,
                });
            } else {
                this.logger.debug({
                    msg:            '✅ Callback delivered',
                    subscriptionId,
                    url,
                    datapointId,
                    httpStatus,
                });
            }
        } catch (err) {
            const isAbort     = err.name === 'AbortError';
            const causeCode   = err.cause?.code;    // e.g. ECONNREFUSED, ETIMEDOUT, ENOTFOUND
            const causeMsg    = err.cause?.message; // OS-level error message

            deliveryError = isAbort
                ? 'Timeout after 10s'
                : (causeCode ? `${err.message} [${causeCode}]` : err.message);

            this.logger.warn({
                msg:            '⚠️  Callback delivery error',
                subscriptionId,
                url,
                datapointId,
                error:          deliveryError,
                errorType:      err.name,
                ...(causeCode  && { causeCode }),
                ...(causeMsg   && { causeMessage: causeMsg }),
            });

            // Only log stack for unexpected errors (not for timeout / ECONNREFUSED etc.)
            if (!isAbort && !causeCode) {
                this.logger.debug({
                    msg:   '⚠️  Unexpected fetch error stack',
                    subscriptionId,
                    stack: err.stack,
                });
            }
        } finally {
            // Always log – regardless of success or failure
            await this.store.logDelivery({
                subscriptionId,
                datapointId,
                triggerType:   'datapoint_write',
                payload,
                httpStatus,
                deliveryError,
                deliveredAt,
            });
        }
    }

    // ------------------------------------------------------------------
    // Payload Builder (JSON:API, KNX IoT Spec 2.1.0)
    // ------------------------------------------------------------------

    /**
     * Builds the notification payload per KNX IoT Spec:
     *
     * Per spec (UpdateEvent.json): data is an array, each item has
     * id, type, links.self and attributes.{value, timestamp}.
     * dpt, ga, eventType are not part of the spec schema.
     *
     * {
     *   "data": [
     *     {
     *       "id":    "<datapointId>",
     *       "type":  "datapoint",
     *       "links": { "self": "/api/v2/datapoints/<id>" },
     *       "attributes": {
     *         "value":     "1",
     *         "timestamp": "2026-05-29T10:00:00Z"
     *       }
     *     }
     *   ]
     * }
     */
    #buildPayload(datapointId, value, timestamp) {
        return {
            data: [
                {
                    id:   datapointId,
                    type: 'datapoint',
                    links: {
                        self: `/api/v2/datapoints/${datapointId}`,
                    },
                    attributes: {
                        value:     value !== undefined ? String(value) : null,
                        timestamp: timestamp ?? new Date().toISOString(),
                    },
                },
            ],
        };
    }

    // ------------------------------------------------------------------
    // Header Builder
    // ------------------------------------------------------------------

    /**
     * Builds the HTTP headers for the callback request.
     *
     * Per spec (line 4463-4468): X-Callback-Signature is a
     * base64-encoded HMAC-SHA256 over the concatenation of:
     *   1. request-line incl. CRLF  → "POST /path HTTP/1.1\r\n"
     *   2. Host header value
     *   3. Date header value
     *   4. Content-Length value
     *   5. full message body
     *
     * @param {string} body        Serialised JSON body
     * @param {string} secret      HMAC key from the subscription
     * @param {string} callbackUrl Full callback URL (for request-line + Host)
     * @param {string} date        HTTP Date header value (toUTCString)
     */
    #buildHeaders(body, secret, callbackUrl, date) {
        const contentLength = Buffer.byteLength(body, 'utf8').toString();

        const headers = {
            'Content-Type':   'application/vnd.api+json',
            'Content-Length': contentLength,
            'Date':           date,
            'User-Agent':     'KNX-IoT-Runtime/0.1.0',
        };

        if (secret) {
            const parsedUrl     = new URL(callbackUrl);
            const requestLine   = `POST ${parsedUrl.pathname}${parsedUrl.search} HTTP/1.1\r\n`;
            const signingString = requestLine
                + parsedUrl.host   // Host
                + date             // Date
                + contentLength    // Content-Length
                + body;            // Message body

            const signature = createHmac('sha256', secret)
                .update(signingString)
                .digest('base64');  // base64, not hex (per spec)

            headers['X-Callback-Signature'] = signature;
        }

        return headers;
    }
}
