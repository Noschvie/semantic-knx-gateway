#!/usr/bin/env berry
#- ─────────────────────────────────────────────────────────────────────────────
   knx_subscribe.be
   load("knx_subscribe.be")

   Subscribes to KNX CoV notifications from semantic-knx-runtime.

   Flow:
     1. Fetch OAuth token (manage + read)
     2. Resolve GA → datapointUUID
     3. Register HTTP callback subscription (httpserver receives POSTs)
     4. Renew subscription periodically (at half lifetime)
     5. Print incoming CoV notifications
     6. Delete subscription on unload / restart

   Configuration: adjust the var lines below, or set Tasmota commands
   before loading:
     Var1  → API_URL           (default http://192.168.1.1:3000)
     Var2  → KNX_GROUP_ADDRESS (default 1/1/93)
     Var3  → CALLBACK_HOST     (Tasmota IP, must be reachable from KNX system)
   ─────────────────────────────────────────────────────────────────────────────
-#

import httpserver
import json
import string

# ── Configuration ─────────────────────────────────────────────────────────────
var CFG_API_URL        = "http://knx-runtime-engine.example.org"
var CFG_API_BASE       = "/api/v2"
var CFG_OAUTH_ID       = "knx-default-client"
var CFG_OAUTH_SECRET   = "change-me-in-production"
var CFG_GROUP_ADDRESS  = "1/1/114"
var CFG_CALLBACK_HOST  = "192.168.1.109"  # IP of this Tasmota instance
var CFG_CALLBACK_PORT  = 8080             # Tasmota's built-in webserver always runs on port 80
var CFG_CALLBACK_PATH  = "/knx_cov"       # endpoint we register
var CFG_LIFETIME_MIN   = 5                # subscription lifetime in minutes
var CFG_INACTIVITY_S   = 60               # shutdown after X seconds without notification

# ── State ─────────────────────────────────────────────────────────────────────
var _manage_token    = nil
var _read_token      = nil
var _subscription_id = nil
var _dp_name         = nil
var _inactivity_ms   = 0  # millis() value of last event; 0 = not yet started

# ── Helpers ───────────────────────────────────────────────────────────────────

def ts()
    # Timestamp string for logging
    var aString = tasmota.time_str(tasmota.rtc()["local"])
    return string.replace(aString, "T", " ")
end

def b64(s)
    # Base64-encode a string for Basic Auth header
    var b = bytes()
    b.fromstring(s)
    return b.tob64()
end

def reset_inactivity()
    _inactivity_ms = tasmota.millis()
end

# ── OAuth ─────────────────────────────────────────────────────────────────────

# Fetches an OAuth token synchronously via webclient.
# Returns the token string or nil on error.
def get_token(scope)
    var cl = webclient()
    var url = CFG_API_URL + "/oauth/access"
    cl.begin(url)
    cl.add_header("Authorization", "Basic " + b64(CFG_OAUTH_ID + ":" + CFG_OAUTH_SECRET))
    cl.add_header("Content-Type", "application/x-www-form-urlencoded")
    var body = "grant_type=client_credentials&scope=" + scope
    var code = cl.POST(body)
    if code != 200
        print(f"[{ts()}] ✗ OAuth '{scope}' failed (HTTP {code})")
        cl.close()
        return nil
    end
    var resp = cl.get_string()
    cl.close()
    var data = json.load(resp)
    if data == nil || !data.contains("access_token")
        print(f"[{ts()}] ✗ OAuth '{scope}': no access_token in response")
        return nil
    end
    return data["access_token"]
end

# ── Datapoint Lookup ──────────────────────────────────────────────────────────

# Resolves a KNX group address to {uuid, datapointId, name, ga, dpt}.
def fetch_dp_by_ga(ga, token)
    var cl = webclient()
    var url = CFG_API_URL + CFG_API_BASE + "/datapoints?filter%5Bga%5D=" + ga
    cl.begin(url)
    cl.add_header("Authorization", "Bearer " + token)
    var code = cl.GET()
    if code != 200
        print(f"[{ts()}] ✗ Datapoint lookup failed (HTTP {code})")
        cl.close()
        return nil
    end
    var resp = cl.get_string()
    cl.close()
    var payload = json.load(resp)
    if payload == nil return nil end
    var arr = payload.find("data")
    if arr == nil || arr.size() == 0 return nil end
    var d = arr[0]
    var meta  = d.find("meta")       if meta  == nil meta  = {} end
    var attrs = d.find("attributes") if attrs == nil attrs = {} end
    return {
        "uuid":        d.find("id"),
        "datapointId": meta.find("datapointId"),
        "name":        attrs.find("title"),
        "ga":          meta.find("ga"),
        "dpt":         meta.find("dpt"),
    }
end

# ── Subscription Management ───────────────────────────────────────────────────

def create_subscription(dp_uuid, callback_url, token)
    var body = {
        "data": {
            "type": "subscription",
            "attributes": {
                "subscriptionType": "callback",
                "url": callback_url,
                "lifetime": {"minutes": CFG_LIFETIME_MIN},
            },
            "relationships": {
                "subscriptionDatapoints": {
                    "data": [{"type": "datapoint", "id": dp_uuid}],
                },
            },
        },
    }
    var cl = webclient()
    cl.begin(CFG_API_URL + CFG_API_BASE + "/subscriptions")
    cl.add_header("Authorization", "Bearer " + token)
    cl.add_header("Content-Type", "application/json")
    var code = cl.POST(json.dump(body))
    if code != 201 && code != 200
        print(f"[{ts()}] ✗ Create subscription failed (HTTP {code}): " + cl.get_string())
        cl.close()
        return nil
    end
    var resp = json.load(cl.get_string())
    cl.close()
    if resp == nil return nil end
    var data = resp.find("data")
    if data == nil return nil end
    return data.find("id")
end

def renew_subscription()
    if _subscription_id == nil return end
    var body = {
        "data": {
            "type": "subscription",
            "id":   _subscription_id,
            "attributes": {"lifetime": {"minutes": CFG_LIFETIME_MIN}},
        },
    }
    var cl = webclient()
    cl.begin(CFG_API_URL + CFG_API_BASE + "/subscriptions/" + _subscription_id)
    cl.add_header("Authorization", "Bearer " + _manage_token)
    cl.add_header("Content-Type", "application/json")
    var code = cl.PATCH(json.dump(body))
    if code == 200 || code == 204
        print(f"[{ts()}] ↺ Subscription renewed (lifetime {CFG_LIFETIME_MIN} min)")
    else
        print(f"[{ts()}] ⚠ Subscription renew failed (HTTP {code})")
    end
    cl.close()
    # Schedule next renewal at half lifetime
    var interval_ms = (CFG_LIFETIME_MIN * 60 * 1000) / 2
    tasmota.set_timer(interval_ms, renew_subscription)
end

def delete_subscription()
    if _subscription_id == nil return end
    var sid = _subscription_id
    _subscription_id = nil
    var cl = webclient()
    cl.begin(CFG_API_URL + CFG_API_BASE + "/subscriptions/" + sid)
    cl.add_header("Authorization", "Bearer " + _manage_token)
    var code = cl.DELETE()
    if code == 200 || code == 204 || code == 404
        print(f"[{ts()}] ✓ Subscription {sid} deleted")
    else
        print(f"[{ts()}] ⚠ Subscription delete failed (HTTP {code})")
    end
    cl.close()
end

# ── Notification Handler ──────────────────────────────────────────────────────

# Called by the httpserver handler with the parsed JSON body.
def handle_notification(body)
    var entries = nil
    if type(body) == 'instance' && classname(body) == 'list'
        entries = body
    elif body.contains("data")
        var d = body["data"]
        if type(d) == 'instance' && classname(d) == 'list'
            entries = d
        else
            entries = [d]
        end
    else
        print(f"[{ts()}] ★ Notification (unknown format): " + json.dump(body))
        return
    end

    var dp = _dp_name ? _dp_name : "?"
    for entry: entries
        var meta  = entry.find("meta")       if meta  == nil meta  = {} end
        var attrs = entry.find("attributes") if attrs == nil attrs = {} end
        var ga    = meta.find("ga")
        if ga == nil ga = attrs.find("knx:groupAddress") end
        if ga == nil ga = entry.find("id") end
        if ga == nil ga = "?" end
        var val    = attrs.find("value")     if val    == nil val    = "?" end
        var ts_raw = attrs.find("timestamp")
        var dpt    = meta.find("dpt")
        var dpt_s  = dpt    ? f"  dpt={dpt}"      : ""
        var ts_s   = ts_raw ? f"  ts={ts_raw}"     : ""
        print(f"[{ts()}] ★ Update  GA={ga}  \"{dp}\"  value={json.dump(val)}{dpt_s}{ts_s}")
    end
end

# ── webserver Endpoint ────────────────────────────────────────────────────────

def register_callback_endpoint()
    httpserver.on(CFG_CALLBACK_PATH,
        def(uri, raw)
            reset_inactivity()

            if raw == nil || raw == ""
                print(f"[{ts()}] ⚠ Empty callback body received")
                return httpserver.send("{}")
            end

            print(f"[{ts()}] → CoV received ({size(raw)} bytes)")

            var body = json.load(raw)
            if body == nil
                print(f"[{ts()}] ★ Notification (not parseable): " + raw)
                return httpserver.send("{}")
            end

            handle_notification(body)
            return httpserver.send("{}")
        end,
        "POST"
    )
    print(f"[{ts()}] HTTP callback registered: POST http://{CFG_CALLBACK_HOST}:{CFG_CALLBACK_PORT}{CFG_CALLBACK_PATH}")
end

# ── Stop ──────────────────────────────────────────────────────────────────────

def stop_knx_subscription()
    print(f"[{ts()}] Stopping KNX subscription...")
    delete_subscription()
    httpserver.stop()
    print(f"[{ts()}] Done.")
end

# ── Inactivity Check ──────────────────────────────────────────────────────────

def check_inactivity()
    if _inactivity_ms == 0 return end  # not yet started
    var elapsed_s = (tasmota.millis() - _inactivity_ms) / 1000
    if elapsed_s >= CFG_INACTIVITY_S
        print(f"\n[{ts()}] No notifications for {CFG_INACTIVITY_S}s — shutting down.")
        stop_knx_subscription()
        return
    end
    tasmota.set_timer(5000, check_inactivity)
end

# ── Start ─────────────────────────────────────────────────────────────────────

def start_knx_subscription()
    print("── Starting KNX Subscription ─────────────────────────")

    # Fetch tokens
    _manage_token = get_token("manage")
    _read_token   = get_token("read")
    if _manage_token == nil || _read_token == nil
        print("Abort: OAuth failed.")
        return
    end

    # Resolve datapoint
    var meta = fetch_dp_by_ga(CFG_GROUP_ADDRESS, _read_token)
    if meta == nil || meta.find("uuid") == nil
        print(f"Abort: No datapoint found for GA \"{CFG_GROUP_ADDRESS}\".")
        return
    end
    _dp_name    = meta.find("name") ? meta["name"] : CFG_GROUP_ADDRESS
    var dp_uuid = meta["uuid"]
    var dp_id   = meta.find("datapointId") ? meta["datapointId"] : "?"

    var callback_url = f"http://{CFG_CALLBACK_HOST}:{CFG_CALLBACK_PORT}{CFG_CALLBACK_PATH}"
    print(f"Callback URL : {callback_url}")
    print(f"Datapoint    : GA={CFG_GROUP_ADDRESS}  datapointId={dp_id}  UUID={dp_uuid}  \"{_dp_name}\"")
    print("")

    # Start httpserver and register callback endpoint
    httpserver.stop()
    httpserver.start(CFG_CALLBACK_PORT)
    register_callback_endpoint()
    tasmota.add_fast_loop(/-> httpserver.process_queue())

    # Create subscription
    _subscription_id = create_subscription(dp_uuid, callback_url, _manage_token)
    if _subscription_id == nil
        print("Abort: Could not create subscription.")
        httpserver.stop()
        return
    end
    print(f"[{ts()}] ✓ Subscription created: {_subscription_id}")
    print("Waiting for notifications... (stop_knx_subscription() to exit)\n")

    # Start inactivity check and auto-renew
    reset_inactivity()
    tasmota.set_timer(5000, check_inactivity)
    var interval_ms = (CFG_LIFETIME_MIN * 60 * 1000) / 2
    tasmota.set_timer(interval_ms, renew_subscription)
end

# ── Autostart ─────────────────────────────────────────────────────────────────
# Starts automatically on load.
# Manual start : start_knx_subscription()
# Manual stop  : stop_knx_subscription()

start_knx_subscription()
