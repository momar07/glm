//! The glue between the engine and pjsua.

use std::ffi::{c_char, CStr, CString};
use std::ptr;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Mutex, OnceLock};

use crate::ffi::*;
use crate::{Command, RegisterOptions, Transport};

/// pjsua is successful when it answers zero.
const PJ_SUCCESS: pj_status_t = 0;
/// The number of codecs pjsua can hold, PJSUA_MAX_CODECS.
const MAX_CODECS: usize = 32;
/// The sound device of the conference bridge, slot zero.
const SOUND_DEVICE: pjsua_conf_port_id = 0;
/// PJSUA_INVALID_ID, the id of nothing.
const PJSUA_INVALID_ID: pjsua_acc_id = -1;
/// PJ_FALSE, the boolean of pjsip is an int.
const PJ_FALSE: pj_bool_t = 0;
/// PJ_TRUE, the boolean of pjsip is an int.
const PJ_TRUE: pj_bool_t = 1;
/// PJSUA_CALL_UNHOLD, the call goes back to the normal.
const PJSUA_CALL_UNHOLD: u32 = 1;
/// PJSIP_TRANSPORT_UDP.
const PJSIP_TRANSPORT_UDP: pjsip_transport_type_e = 1;
/// PJSIP_TRANSPORT_TCP.
const PJSIP_TRANSPORT_TCP: pjsip_transport_type_e = 2;
/// PJSIP_TRANSPORT_TLS.
const PJSIP_TRANSPORT_TLS: pjsip_transport_type_e = 3;
/// PJMEDIA_TONEGEN_LOOP, the tone starts again after the last one.
const PJMEDIA_TONEGEN_LOOP: u32 = 1;
/// The clock of the ringtone, 8 kHz mono as the narrowband codecs.
const TONE_CLOCK_RATE: u32 = 8000;
/// 20 ms of audio per frame.
const TONE_SAMPLES_PER_FRAME: u32 = 160;

/// What the engine tells the application.
#[derive(Debug, Clone)]
pub enum EngineEvent {
    /// The registration of the account changed.
    Registration {
        extension: String,
        ok: bool,
        status: String,
    },
    /// A call rings.
    Incoming {
        call_id: pjsua_call_id,
        from: String,
        to: String,
    },
    /// The state of a call changed.
    CallState {
        call_id: pjsua_call_id,
        state: String,
        text: String,
    },
    /// The media of a call is ready (or gone).
    Media {
        call_id: pjsua_call_id,
        active: bool,
    },
    /// The codecs of the engine and their priority.
    Codecs { codecs: Vec<(String, u8)> },
    /// Something went wrong.
    Error { message: String },
}

/// pjsua calls back from its own threads, the events go out through here.
static EVENTS: OnceLock<Mutex<Option<Sender<EngineEvent>>>> = OnceLock::new();

/// The account that is registered, the callbacks need its extension.
static EXTENSION: OnceLock<Mutex<String>> = OnceLock::new();

/// The slot of the audio of the calls, the mute uses it.
static SLOTS: OnceLock<Mutex<std::collections::HashMap<pjsua_call_id, pjsua_conf_port_id>>> =
    OnceLock::new();

/// The slot of the audio of a call.
fn call_slot(call_id: pjsua_call_id) -> pjsua_conf_port_id {
    SLOTS
        .get()
        .and_then(|slots| {
            slots
                .lock()
                .ok()
                .and_then(|slots| slots.get(&call_id).copied())
        })
        .unwrap_or(SOUND_DEVICE)
}

fn emit(event: EngineEvent) {
    if let Some(slot) = EVENTS.get() {
        if let Ok(guard) = slot.lock() {
            if let Some(sender) = guard.as_ref() {
                let _ = sender.send(event);
            }
        }
    }
}

fn current_extension() -> String {
    EXTENSION
        .get()
        .and_then(|slot| slot.lock().ok().map(|value| value.clone()))
        .unwrap_or_default()
}

/// A pj_str_t out of a C string.
unsafe fn to_pj_str(text: &CStr) -> pj_str_t {
    pj_str_t {
        ptr: text.as_ptr() as *mut c_char,
        slen: text.to_bytes().len() as i64,
    }
}

/// A string out of a pj_str_t, it is not a C string, it has a length.
unsafe fn to_string(value: &pj_str_t) -> String {
    if value.ptr.is_null() || value.slen <= 0 {
        return String::new();
    }
    let bytes = std::slice::from_raw_parts(value.ptr as *const u8, value.slen as usize);
    String::from_utf8_lossy(bytes).into_owned()
}

unsafe extern "C" fn on_incoming_call(
    _acc_id: pjsua_acc_id,
    call_id: pjsua_call_id,
    _rdata: *mut pjsip_rx_data,
) {
    let mut info: pjsua_call_info = std::mem::zeroed();
    pjsua_call_get_info(call_id, &mut info);
    emit(EngineEvent::Incoming {
        call_id,
        from: to_string(&info.remote_info),
        to: to_string(&info.local_info),
    });
}

unsafe extern "C" fn on_call_state(call_id: pjsua_call_id, _event: *mut pjsip_event) {
    let mut info: pjsua_call_info = std::mem::zeroed();
    pjsua_call_get_info(call_id, &mut info);
    emit(EngineEvent::CallState {
        call_id,
        state: format!("{}", info.state),
        text: to_string(&info.state_text),
    });
}

unsafe extern "C" fn on_call_media_state(call_id: pjsua_call_id) {
    let mut info: pjsua_call_info = std::mem::zeroed();
    pjsua_call_get_info(call_id, &mut info);
    // the audio of the call goes to the sound device of the machine
    if info.media_cnt > 0 {
        let slot = info.media[0].stream.aud.conf_slot;
        pjsua_conf_connect(slot, SOUND_DEVICE);
        if let Some(slots) = SLOTS.get() {
            if let Ok(mut slots) = slots.lock() {
                slots.insert(call_id, slot);
            }
        }
    }
    // a held call keeps its media section: the state is what changed
    emit(EngineEvent::Media {
        call_id,
        active: info.media_cnt > 0 && info.media[0].status as u32 == PJSUA_CALL_MEDIA_ACTIVE,
    });
}

unsafe extern "C" fn on_reg_state2(_acc_id: pjsua_acc_id, info: *mut pjsua_reg_info) {
    let info = &*info;
    let (code, text) = if info.cbparam.is_null() {
        (0, String::new())
    } else {
        let cbparam = &*info.cbparam;
        (cbparam.code, to_string(&cbparam.reason))
    };
    emit(EngineEvent::Registration {
        extension: current_extension(),
        ok: code == 200,
        status: text,
    });
}

/// The callbacks of pjsua, only the ones the engine needs are set.
fn callbacks() -> pjsua_callback {
    let mut callbacks: pjsua_callback = unsafe { std::mem::zeroed() };
    callbacks.on_call_state = Some(on_call_state);
    callbacks.on_incoming_call = Some(on_incoming_call);
    callbacks.on_call_media_state = Some(on_call_media_state);
    callbacks.on_reg_state2 = Some(on_reg_state2);
    callbacks
}

/// The body of the thread of the engine.
pub(crate) fn run(commands: Receiver<Command>, events: Sender<EngineEvent>) {
    EVENTS.set(Mutex::new(Some(events))).ok();
    EXTENSION.set(Mutex::new(String::new())).ok();
    SLOTS.set(Mutex::new(std::collections::HashMap::new())).ok();

    unsafe {
        if pjsua_create() != PJ_SUCCESS {
            emit(EngineEvent::Error {
                message: "pjsua could not be created".to_string(),
            });
            return;
        }

        let mut ua: pjsua_config = std::mem::zeroed();
        pjsua_config_default(&mut ua);
        ua.cb = callbacks();
        ua.max_calls = 32;
        ua.thread_cnt = 2;

        let mut logging: pjsua_logging_config = std::mem::zeroed();
        pjsua_logging_config_default(&mut logging);
        logging.level = 5;
        // stdout belongs to the JSON-lines protocol of the helper: the log of
        // pjsua goes to the file of SIP_HELPER_LOG, or nowhere
        logging.console_level = 0;
        if let Ok(path) = std::env::var("SIP_HELPER_LOG") {
            if let Ok(path) = CString::new(path) {
                logging.log_filename = to_pj_str(&path);
            }
        }

        let mut media: pjsua_media_config = std::mem::zeroed();
        pjsua_media_config_default(&mut media);
        // the calls are made without the ice, the box is in the same network
        media.enable_ice = 0;

        if pjsua_init(&ua, &logging, &media) != PJ_SUCCESS {
            emit(EngineEvent::Error {
                message: "pjsua could not be started".to_string(),
            });
            pjsua_destroy();
            return;
        }

        // the state of pjsua goes to running, without it the calls are
        // refused with "object is busy"
        if pjsua_start() != PJ_SUCCESS {
            emit(EngineEvent::Error {
                message: "pjsua could not run".to_string(),
            });
            pjsua_destroy();
            return;
        }

        // the sound device of the machine, there may be none (a server)
        let mut capture: i32 = -1;
        let mut playback: i32 = -1;
        pjsua_get_snd_dev(&mut capture, &mut playback);
        if capture < 0 || playback < 0 {
            pjsua_set_null_snd_dev();
        }
    }

    let mut account: Option<pjsua_acc_id> = None;
    let mut server = String::new();
    // the port of the ringtone, created on the first ring of the process
    let mut ring: Option<Ring> = None;

    for command in commands {
        match command {
            Command::Register(options, reply) => {
                let result = register(&options, &mut account, &mut server);
                let _ = reply.send(result);
            }
            Command::Unregister => {
                if let Some(acc_id) = account {
                    unsafe {
                        pjsua_acc_set_registration(acc_id, PJ_FALSE);
                    }
                }
            }
            Command::Call(number, reply) => {
                let result = call(&number, &server, account);
                let _ = reply.send(result);
            }
            Command::Answer(call_id) => unsafe {
                let mut setting: pjsua_call_setting = std::mem::zeroed();
                pjsua_call_setting_default(&mut setting);
                setting.aud_cnt = 1;
                setting.vid_cnt = 0;
                pjsua_call_answer2(call_id, &setting, 200, ptr::null(), ptr::null());
            },
            Command::Mute(call_id, on) => {
                unsafe {
                    // the level of the audio that goes out, zero is the mute
                    let slot = call_slot(call_id);
                    pjsua_conf_adjust_tx_level(slot, if on { 0.0 } else { 1.0 });
                }
            }
            Command::Hangup(call_id) => unsafe {
                pjsua_call_hangup(call_id, 0, ptr::null(), ptr::null());
            },
            Command::Hold(call_id, on) => unsafe {
                if on {
                    pjsua_call_set_hold(call_id, ptr::null());
                } else {
                    let mut setting: pjsua_call_setting = std::mem::zeroed();
                    pjsua_call_setting_default(&mut setting);
                    setting.flag |= PJSUA_CALL_UNHOLD;
                    pjsua_call_reinvite2(call_id, &setting, ptr::null());
                }
            },
            Command::Dtmf(call_id, digits) => unsafe {
                if let Ok(digits) = CString::new(digits) {
                    pjsua_call_dial_dtmf(call_id, &to_pj_str(&digits));
                }
            },
            Command::Transfer(call_id, target) => unsafe {
                if let Ok(target) = CString::new(format!("sip:{}@{}", target, server)) {
                    pjsua_call_xfer(call_id, &to_pj_str(&target), ptr::null());
                }
            },
            Command::Ring(on) => {
                set_ring(&mut ring, on);
            }
            Command::Shutdown => {
                set_ring(&mut ring, false);
                break;
            }
        }
    }

    unsafe {
        pjsua_destroy();
    }
}

/// The ringing port: a tone generator wired into the conference bridge.
struct Ring {
    port: *mut pjmedia_port,
    playing: bool,
}

/// The ringtone of an incoming call: ring, ring, silence. The port is created
/// once and the tone is only stopped and restarted.
///
/// ponytail: the pool and its caching pool intentionally live for the life of
/// the process (about a megabyte); the helper exits together with the app.
fn set_ring(ring: &mut Option<Ring>, on: bool) {
    unsafe {
        if on && ring.is_none() {
            let caching = Box::leak(Box::new(std::mem::zeroed::<pj_caching_pool>()));
            pj_caching_pool_init(caching, ptr::null(), 1024 * 1024);
            let pool_name = CString::new("ringtone").unwrap();
            let pool = pj_pool_create(&mut caching.factory, pool_name.as_ptr(), 4096, 4096, None);
            if pool.is_null() {
                emit(EngineEvent::Error {
                    message: "the pool of the ringtone could not be made".to_string(),
                });
                return;
            }
            let name = CString::new("ringtone").unwrap();
            let mut port: *mut pjmedia_port = ptr::null_mut();
            let status = pjmedia_tonegen_create2(
                pool,
                &to_pj_str(&name),
                TONE_CLOCK_RATE,
                1,
                TONE_SAMPLES_PER_FRAME,
                16,
                PJMEDIA_TONEGEN_LOOP,
                &mut port,
            );
            if status != PJ_SUCCESS || port.is_null() {
                emit(EngineEvent::Error {
                    message: format!("the ringtone could not be created: {}", status),
                });
                return;
            }
            let mut slot: pjsua_conf_port_id = 0;
            let status = pjsua_conf_add_port(pool, port, &mut slot);
            if status != PJ_SUCCESS {
                emit(EngineEvent::Error {
                    message: format!("the ringtone could not be added: {}", status),
                });
                return;
            }
            // the ringtone plays to the speakers of the machine
            pjsua_conf_connect(slot, SOUND_DEVICE);
            *ring = Some(Ring {
                port,
                playing: false,
            });
        }

        let Some(ring) = ring.as_mut() else {
            return;
        };
        if on {
            if ring.playing {
                return;
            }
            // two descs: ring-ring, then the long silence, looping
            let tones = [
                pjmedia_tone_desc {
                    freq1: 440,
                    freq2: 480,
                    on_msec: 400,
                    off_msec: 200,
                    volume: 0,
                    flags: 0,
                },
                pjmedia_tone_desc {
                    freq1: 440,
                    freq2: 480,
                    on_msec: 400,
                    off_msec: 2000,
                    volume: 0,
                    flags: 0,
                },
            ];
            let status = pjmedia_tonegen_play(
                ring.port,
                tones.len() as u32,
                tones.as_ptr(),
                PJMEDIA_TONEGEN_LOOP,
            );
            if status == PJ_SUCCESS {
                ring.playing = true;
            }
        } else if ring.playing {
            pjmedia_tonegen_stop(ring.port);
            ring.playing = false;
        }
    }
}

/// Registers the account of the agent.
fn register(
    options: &RegisterOptions,
    account: &mut Option<pjsua_acc_id>,
    server: &mut String,
) -> Result<(), String> {
    unsafe {
        // a second register (a reload of the window, a profile switch)
        // re-registers the existing account in place: deleting it first
        // would send an un-REGISTER and pjsua_acc_add would then fail on
        // the duplicate account id, leaving the engine with no account
        if let Some(acc_id) = *account {
            let status = pjsua_acc_set_registration(acc_id, PJ_TRUE);
            if status != PJ_SUCCESS {
                return Err(format!("the account could not be registered: {}", status));
            }
            set_codecs(&options.codecs);
            *server = options.server.clone();
            return Ok(());
        }
        // the transport of the signalling, the local port is free
        let mut transport_config: pjsua_transport_config = std::mem::zeroed();
        pjsua_transport_config_default(&mut transport_config);
        transport_config.port = 0;

        let transport_type = match options.transport {
            Transport::Udp => PJSIP_TRANSPORT_UDP,
            Transport::Tcp => PJSIP_TRANSPORT_TCP,
            Transport::Tls => PJSIP_TRANSPORT_TLS,
        };
        let mut transport_id: pjsua_transport_id = 0;
        let status = pjsua_transport_create(transport_type, &transport_config, &mut transport_id);
        if status != PJ_SUCCESS {
            return Err(format!("the transport could not be created: {}", status));
        }

        let id = format!("sip:{}@{}", options.extension, options.server);
        let registry = format!("sip:{}:{}", options.server, options.port);
        let id = CString::new(id).map_err(|error| error.to_string())?;
        let registry = CString::new(registry).map_err(|error| error.to_string())?;
        let extension = CString::new(options.extension.clone()).map_err(|e| e.to_string())?;
        let password = CString::new(options.password.clone()).map_err(|e| e.to_string())?;
        let scheme = CString::new("digest").unwrap();
        let realm = CString::new("*").unwrap();

        let mut config: pjsua_acc_config = std::mem::zeroed();
        pjsua_acc_config_default(&mut config);
        config.id = to_pj_str(&id);
        config.reg_uri = to_pj_str(&registry);
        config.register_on_acc_add = 1;
        config.transport_id = transport_id;
        config.cred_count = 1;
        config.cred_info[0].scheme = to_pj_str(&scheme);
        config.cred_info[0].realm = to_pj_str(&realm);
        config.cred_info[0].username = to_pj_str(&extension);
        config.cred_info[0].data_type = 0;
        config.cred_info[0].data = to_pj_str(&password);

        let mut acc_id: pjsua_acc_id = PJSUA_INVALID_ID;
        let status = pjsua_acc_add(&config, PJ_FALSE, &mut acc_id);
        if status != PJ_SUCCESS {
            return Err(format!("the account could not be added: {}", status));
        }

        set_codecs(&options.codecs);

        *account = Some(acc_id);
        *server = options.server.clone();
        if let Some(slot) = EXTENSION.get() {
            if let Ok(mut value) = slot.lock() {
                *value = options.extension.clone();
            }
        }
        Ok(())
    }
}

/// Calls a number.
fn call(
    number: &str,
    server: &str,
    account: Option<pjsua_acc_id>,
) -> Result<pjsua_call_id, String> {
    let acc_id = account.ok_or("the account is not registered")?;
    unsafe {
        let target =
            CString::new(format!("sip:{}@{}", number, server)).map_err(|e| e.to_string())?;
        let mut call_id: pjsua_call_id = 0;
        let status = pjsua_call_make_call(
            acc_id,
            &to_pj_str(&target),
            ptr::null(),
            ptr::null_mut(),
            ptr::null(),
            &mut call_id,
        );
        if status != PJ_SUCCESS {
            return Err(format!("the call could not be made: {}", status));
        }
        Ok(call_id)
    }
}

/// PJSUA_CALL_MEDIA_ACTIVE: both directions of the audio are flowing.
const PJSUA_CALL_MEDIA_ACTIVE: u32 = 1;

/// The priority of the codecs: the first one of the list wins, the others are
/// switched off.
fn set_codecs(codecs: &[String]) {
    unsafe {
        // the function fills the array, it does not count the codecs when the
        // array is empty
        let mut count: u32 = MAX_CODECS as u32;
        let mut infos: Vec<pjsua_codec_info> = vec![std::mem::zeroed(); MAX_CODECS];
        pjsua_enum_codecs(infos.as_mut_ptr(), &mut count);
        let mut list: Vec<(String, u8)> = Vec::new();
        for info in infos.iter().take(count as usize) {
            // the id of a codec is "PCMU/8000/1", the name is "PCMU"
            let id = to_string(&info.codec_id);
            let name = id.split('/').next().unwrap_or("").to_string();
            let position = codecs.iter().position(|codec| {
                codec.eq_ignore_ascii_case(&name) || codec.eq_ignore_ascii_case(&id)
            });
            let priority = match position {
                Some(index) => 255u8.saturating_sub(index as u8),
                None => 0,
            };
            pjsua_codec_set_priority(&info.codec_id, priority);
            if priority > 0 {
                list.push((id, priority));
            }
        }
        emit(EngineEvent::Codecs { codecs: list });
    }
}
