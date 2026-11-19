//! The test of the engine: it registers on the asterisk of the verification,
//! it takes the call that comes and it hangs it up.
//!
//!   sip-smoke <server> <port> <extension> <password>

use std::time::{Duration, Instant};

use sip_engine::{Engine, EngineEvent, RegisterOptions, Transport};

fn main() {
    let mut args = std::env::args().skip(1);
    let server = args.next().unwrap_or_else(|| "127.0.0.1".to_string());
    let port: u16 = args.next().and_then(|p| p.parse().ok()).unwrap_or(5062);
    let extension = args.next().unwrap_or_else(|| "1000".to_string());
    let password = args.next().unwrap_or_else(|| "sip-secret".to_string());

    let mut engine = Engine::start();
    let events = engine.take_events().expect("the events of the engine");
    let options = RegisterOptions {
        server,
        port,
        extension,
        password,
        transport: Transport::Udp,
        codecs: vec!["G729".to_string(), "PCMA".to_string(), "PCMU".to_string()],
    };
    match engine.register(options) {
        Ok(()) => println!("ok: the account is added"),
        Err(error) => {
            println!("FAIL: the account could not be added: {}", error);
            std::process::exit(1);
        }
    }

    let mut answered = false;
    let mut registered = false;
    let mut hangup_at: Option<Instant> = None;
    let deadline = Instant::now() + Duration::from_secs(60);

    while Instant::now() < deadline {
        if let Some(at) = hangup_at {
            if Instant::now() >= at {
                println!("ok: the call is answered, it is hung up");
                engine.hangup(0);
                hangup_at = Some(Instant::now() + Duration::from_secs(10));
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(left) {
            Ok(EngineEvent::Registration { ok, status, .. }) => {
                println!("registration ok={} status={}", ok, status);
                if ok {
                    registered = true;
                }
            }
            Ok(EngineEvent::Codecs { codecs }) => {
                println!("codecs: {:?}", codecs);
            }
            Ok(EngineEvent::Incoming { call_id, from, to }) => {
                println!("ok: the call {} rings, from {} to {}", call_id, from, to);
                engine.answer(call_id);
                answered = true;
            }
            Ok(EngineEvent::CallState {
                call_id,
                state,
                text,
            }) => {
                println!("call {} state {} ({})", call_id, state, text);
                if text.to_lowercase().contains("disconnected") {
                    println!("ok: the call is over");
                    engine.shutdown();
                    std::process::exit(0);
                }
            }
            Ok(EngineEvent::Media { call_id, active }) => {
                println!("media of the call {} active={}", call_id, active);
                if active && answered && hangup_at.is_none() {
                    hangup_at = Some(Instant::now() + Duration::from_secs(3));
                }
            }
            Ok(EngineEvent::Error { message }) => {
                println!("FAIL: {}", message);
                std::process::exit(1);
            }
            Err(_) => break,
        }
    }

    if !registered {
        println!("FAIL: the registration did not succeed");
        std::process::exit(1);
    }
    println!("FAIL: no call came");
    std::process::exit(1);
}
