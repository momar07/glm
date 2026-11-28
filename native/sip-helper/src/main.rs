//! The native sip helper of GLMWebrtc.
//!
//! One JSON object per line on stdin (a command), one per line on stdout (an
//! answer or an event). The engine owns the sound device and the ringtone:
//! the renderer never touches the audio of a native call.
//!
//!   {"id":1,"cmd":"register","server":"…","port":5060,"extension":"1000",
//!    "password":"…","transport":"udp","codecs":["G729","PCMA","PCMU"]}
//!   {"id":1,"ok":true}
//!   {"event":"incoming","callId":0,"from":"sip:1333@…","to":"sip:1000@…"}

use std::io::{self, BufRead, Write};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use sip_engine::{Engine, EngineEvent, RegisterOptions, Transport};

fn state_name(state: &str) -> &'static str {
    match state {
        "0" => "NULL",
        "1" => "CALLING",
        "2" => "INCOMING",
        "3" => "EARLY",
        "4" => "CONNECTING",
        "5" => "CONFIRMED",
        "6" => "DISCONNECTED",
        _ => "UNKNOWN",
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|v| v.as_i64())
}

fn write_line(out: &mut impl Write, value: Value) {
    let _ = writeln!(out, "{}", value);
    let _ = out.flush();
}

fn emit_event(out: &mut impl Write, event: EngineEvent) {
    let value = match event {
        EngineEvent::Registration {
            extension,
            ok,
            status,
        } => json!({
            "event": "registration",
            "extension": extension,
            "ok": ok,
            "status": status,
        }),
        EngineEvent::Incoming { call_id, from, to } => json!({
            "event": "incoming",
            "callId": call_id,
            "from": from,
            "to": to,
        }),
        EngineEvent::CallState {
            call_id,
            state,
            text,
        } => json!({
            "event": "callState",
            "callId": call_id,
            "state": state_name(&state),
            "text": text,
        }),
        EngineEvent::Media { call_id, active } => json!({
            "event": "media",
            "callId": call_id,
            "active": active,
        }),
        EngineEvent::Codecs { codecs } => json!({
            "event": "codecs",
            "codecs": codecs
                .iter()
                .map(|(id, priority)| json!({"id": id, "priority": priority}))
                .collect::<Vec<_>>(),
        }),
        EngineEvent::Devices {
            capture,
            playback,
            devices,
        } => json!({
            "event": "devices",
            "capture": capture,
            "playback": playback,
            "devices": devices,
        }),
        EngineEvent::Error { message } => json!({
            "event": "error",
            "message": message,
        }),
    };
    write_line(out, value);
}

/// Handles one command line. False stops the process.
fn handle(engine: &Engine, out: &mut impl Write, line: &str) -> bool {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            write_line(out, json!({"error": format!("bad json: {error}")}));
            return true;
        }
    };
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    let command = text(&value, "cmd");

    let result: Result<Value, String> = match command.as_str() {
        "register" => {
            let transport = match text(&value, "transport").to_ascii_lowercase().as_str() {
                "tcp" => Transport::Tcp,
                "tls" => Transport::Tls,
                _ => Transport::Udp,
            };
            let codecs: Vec<String> = value
                .get("codecs")
                .and_then(|v| v.as_array())
                .map(|list| {
                    list.iter()
                        .filter_map(|c| c.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let options = RegisterOptions {
                server: text(&value, "server"),
                port: number(&value, "port").unwrap_or(5060) as u16,
                extension: text(&value, "extension"),
                password: text(&value, "password"),
                transport,
                // the priority of the agent: G.729 first, the narrowband G.711
                // as the fallback
                codecs: if codecs.is_empty() {
                    vec!["G729".to_string(), "PCMA".to_string(), "PCMU".to_string()]
                } else {
                    codecs
                },
                // the sound devices of the agent, by name; an absent or
                // empty name keeps the defaults of the system
                capture_device: match text(&value, "captureDevice") {
                    name if name.is_empty() => None,
                    name => Some(name),
                },
                playback_device: match text(&value, "playbackDevice") {
                    name if name.is_empty() => None,
                    name => Some(name),
                },
            };
            engine.register(options).map(|_| json!({}))
        }
        "unregister" => {
            engine.unregister();
            Ok(json!({}))
        }
        "call" => engine
            .call(&text(&value, "target"))
            .map(|call_id| json!({"callId": call_id})),
        "answer" => match number(&value, "callId") {
            Some(call_id) => {
                engine.answer(call_id as i32);
                Ok(json!({}))
            }
            None => Err("callId is required".to_string()),
        },
        "hangup" => match number(&value, "callId") {
            Some(call_id) => {
                engine.hangup(call_id as i32);
                Ok(json!({}))
            }
            None => Err("callId is required".to_string()),
        },
        "mute" => match number(&value, "callId") {
            Some(call_id) => {
                engine.mute(
                    call_id as i32,
                    value.get("on").and_then(|v| v.as_bool()).unwrap_or(false),
                );
                Ok(json!({}))
            }
            None => Err("callId is required".to_string()),
        },
        "hold" => match number(&value, "callId") {
            Some(call_id) => {
                engine.hold(
                    call_id as i32,
                    value.get("on").and_then(|v| v.as_bool()).unwrap_or(false),
                );
                Ok(json!({}))
            }
            None => Err("callId is required".to_string()),
        },
        "dtmf" => match number(&value, "callId") {
            Some(call_id) => {
                engine.dtmf(call_id as i32, &text(&value, "digits"));
                Ok(json!({}))
            }
            None => Err("callId is required".to_string()),
        },
        "transfer" => match number(&value, "callId") {
            Some(call_id) => {
                engine.transfer(call_id as i32, &text(&value, "target"));
                Ok(json!({}))
            }
            None => Err("callId is required".to_string()),
        },
        "ping" => Ok(json!({})),
        "shutdown" => {
            engine.shutdown();
            // pjsua destroys itself on its own thread; give it a moment so the
            // sound device is released before the process goes away
            thread::sleep(Duration::from_millis(400));
            return false;
        }
        other => Err(format!("unknown command: {other}")),
    };

    match result {
        Ok(extra) => {
            let mut answer = json!({"id": id, "ok": true});
            if let (Some(map), Some(object)) = (extra.as_object(), answer.as_object_mut()) {
                for (key, value) in map {
                    object.insert(key.clone(), value.clone());
                }
            }
            write_line(out, answer);
        }
        Err(error) => write_line(out, json!({"id": id, "error": error})),
    }
    true
}

fn main() {
    let mut engine = Engine::start();
    let events = match engine.take_events() {
        Some(events) => events,
        None => {
            eprintln!("the events of the engine are not available");
            return;
        }
    };

    let (line_tx, line_rx) = channel::<String>();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    if line_tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut out = io::stdout();
    let mut ringing = false;

    loop {
        match events.recv_timeout(Duration::from_millis(20)) {
            Ok(event) => {
                // the helper rings by itself: the renderer must not play a
                // ringtone on a native call (the engine owns the sound device)
                match &event {
                    EngineEvent::Incoming { .. } => {
                        if !ringing {
                            engine.ring(true);
                            ringing = true;
                        }
                    }
                    EngineEvent::CallState { state, .. } => {
                        let name = state_name(state);
                        if ringing && (name == "CONFIRMED" || name == "DISCONNECTED") {
                            engine.ring(false);
                            ringing = false;
                        }
                    }
                    _ => {}
                }
                emit_event(&mut out, event);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        while let Ok(line) = line_rx.try_recv() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if !handle(&engine, &mut out, line) {
                return;
            }
        }
    }
}
