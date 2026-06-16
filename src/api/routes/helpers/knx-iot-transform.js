// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// helpers/knx-iot-transform.js – JSON:API Resource-Transformationen

import { stableUuid } from './knx-iot-uuid.js';
import { gaToInteger, resolveDatapointTypes, toSpecValue } from './knx-iot-dpt.js';

/**
 * Transforms an internal datapoint state into a JSON:API resource.
 * @param {Object} state - Row from current_state + optional semantic data
 */
export function toDatapointResource(state) {
    const uuid     = stableUuid(state.datapointId ?? state.datapoint_id ?? '');
    const gaInt    = gaToInteger(state.ga);
    const dptTypes = resolveDatapointTypes(state.dpt);
    const { value, valueType } = toSpecValue(state.value);

    return {
        id:   uuid,
        type: 'datapoint',
        attributes: {
            title:    state.name ?? state.datapointId ?? state.ga ?? '',
            readable: state.readable ?? true,
            writable: state.writable ?? true,
            value,
            valueType,
            timestamp:     state.updatedAt ?? state.updated_at ?? null,
            datapointType: dptTypes,
            ...(gaInt !== null ? { 'knx:groupAddress': gaInt } : {}),
        },
        meta: {
            '@type':     dptTypes.map(t => t.replace('knx:', 'knx:dpa.')),
            datapointId: state.datapointId,
            ga:          state.ga,
            dpt:         state.dpt,
        },
        relationships: {
            datapointFunctions: { links: { related: `/functions?datapointId=${uuid}` } },
            datapointDevice:    { links: { related: `/devices?datapointId=${uuid}` } }
        }
    };
}

/**
 * Transforms a location into a JSON:API resource.
 */
export function toLocationResource(loc) {
    const uuid = stableUuid(loc.id ?? loc.uri ?? '');
    return {
        id:   uuid,
        type: 'location',
        attributes: { title: loc.name ?? '', subtype: loc.subtype ?? 'room' },
        meta: { '@type': [`knx:${loc.subtype ?? 'location'}`], internalId: loc.id, uri: loc.uri },
        relationships: {
            childLocations: { links: { related: `/locations/${uuid}/childlocations` } },
            parentLocation: { links: { related: `/locations/${uuid}/parentlocation` } }
        }
    };
}

/**
 * Transforms a device into a JSON:API resource.
 */
export function toDeviceResource(dev) {
    const uuid = stableUuid(dev.id ?? dev.uri ?? '');
    return {
        id:   uuid,
        type: 'device',
        attributes: {
            title:        dev.name ?? '',
            manufacturer: dev.manufacturer ?? null,
            serialNumber: dev.serialNumber ?? null,
            physAddr:     dev.physAddr ?? null,
            mediaType:    dev.mediaType ?? null,
            state:        dev.state ?? null,
        },
        meta: { '@type': ['knx:device'], internalId: dev.id, uri: dev.uri },
        relationships: {
            datapoints: { links: { related: `/api/v1/datapoints?filter[deviceId]=${uuid}` } },
            ...(dev.room ? { location: { links: { related: `/api/v1/locations?filter[deviceId]=${uuid}` } } } : {})
        }
    };
}

/**
 * Transforms a function into a JSON:API resource.
 */
export function toFunctionResource(fn) {
    const uuid = stableUuid(fn.id ?? fn.uri ?? '');

    // Build datapoint relationship links for each linked group address
    const groupAddressLinks = (fn.groupAddressUris ?? []).map(gaUri => ({
        id:   stableUuid(gaUri),
        type: 'datapoint',
    }));

    return {
        id:   uuid,
        type: 'function',
        attributes: { title: fn.name ?? '' },
        meta: {
            '@type':     ['knx:function'],
            internalId:  fn.id,
            uri:         fn.uri,
            groupAddressCount: fn.groupAddressUris?.length ?? fn.groupAddressCount ?? 0,
        },
        relationships: {
            datapoints: groupAddressLinks.length > 0
                ? { data: groupAddressLinks }
                : { links: { related: `/api/v1/datapoints?filter[functionId]=${uuid}` } },
        },
    };
}

/**
 * * Loads all locations from the SemanticEngine.
 *  * Supports both known access paths (direct or via semanticMapper).
 */
export async function getAllLocations(semanticEngine) {
    return await semanticEngine.resourceStore?.getResourcesByType('location')
        ?? await semanticEngine.semanticMapper?.resourceStore?.getResourcesByType('location')
        ?? [];
}
