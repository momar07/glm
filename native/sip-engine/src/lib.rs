//! The sip engine of the softphone.
//!
//! pjsua is not thread safe, so it lives in a thread of its own: the
//! application sends it commands and it listens to its events. The bindings
//! are made by bindgen in build.rs, the library is the one of
//! tools/build-pjproject.sh.

mod engine;
mod ffi;

use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;
use std::time::Duration;

pub use engine::EngineEvent;

/// The transport of the sip signalling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Udp,
    Tcp,
    Tls,
}

/// What the engine needs to register an account.
#[derive(Debug, Clone)]
pub struct RegisterOptions {
    pub server: String,
    pub port: u16,
    pub extension: String,
    pub password: String,
    pub transport: Transport,
    /// The codecs in the order of the priority: "PCMA", "PCMU", "G729".
    pub codecs: Vec<String>,
}

impl Default for RegisterOptions {
    fn default() -> Self {
        RegisterOptions {
            server: String::new(),
            port: 5060,
            extension: String::new(),
            password: String::new(),
            transport: Transport::Udp,
            codecs: vec!["PCMA".to_string(), "PCMU".to_string()],
        }
    }
}

/// What the engine is asked to do.
pub(crate) enum Command {
    Register(RegisterOptions, Sender<Result<(), String>>),
    Unregister,
    Call(String, Sender<Result<i32, String>>),
    Answer(i32),
    Mute(i32, bool),
    Hangup(i32),
    Hold(i32, bool),
    Dtmf(i32, String),
    Transfer(i32, String),
    Ring(bool),
    Shutdown,
}

/// The handle of the engine.
pub struct Engine {
    commands: Sender<Command>,
    events: Option<Receiver<EngineEvent>>,
}

impl Engine {
    /// Starts the engine, the thread of pjsua is running.
    pub fn start() -> Engine {
        let (command_tx, command_rx) = channel();
        let (event_tx, event_rx) = channel();
        thread::Builder::new()
            .name("sip".to_string())
            .spawn(move || engine::run(command_rx, event_tx))
            .expect("the thread of the sip engine could not be started");
        Engine {
            commands: command_tx,
            events: Some(event_rx),
        }
    }

    /// Takes the events of the engine, the application listens to them. There
    /// is only one listener, the events are gone after.
    pub fn take_events(&mut self) -> Option<Receiver<EngineEvent>> {
        self.events.take()
    }

    /// The events of the engine: the registration, the calls, the media.
    pub fn events(&self) -> Option<&Receiver<EngineEvent>> {
        self.events.as_ref()
    }

    /// Registers the account of the agent.
    pub fn register(&self, options: RegisterOptions) -> Result<(), String> {
        let (tx, rx) = channel();
        self.commands
            .send(Command::Register(options, tx))
            .map_err(|error| error.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|error| Err(error.to_string()))
    }

    /// Unregisters the account.
    pub fn unregister(&self) {
        let _ = self.commands.send(Command::Unregister);
    }

    /// Calls a number, it answers the id of the call.
    pub fn call(&self, number: &str) -> Result<i32, String> {
        let (tx, rx) = channel();
        self.commands
            .send(Command::Call(number.to_string(), tx))
            .map_err(|error| error.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|error| Err(error.to_string()))
    }

    /// Answers a call that rings.
    pub fn answer(&self, call_id: i32) {
        let _ = self.commands.send(Command::Answer(call_id));
    }

    /// Mutes the microphone of a call.
    pub fn mute(&self, call_id: i32, on: bool) {
        let _ = self.commands.send(Command::Mute(call_id, on));
    }

    /// Hangs a call up.
    pub fn hangup(&self, call_id: i32) {
        let _ = self.commands.send(Command::Hangup(call_id));
    }

    /// Puts a call on hold or takes it back.
    pub fn hold(&self, call_id: i32, on: bool) {
        let _ = self.commands.send(Command::Hold(call_id, on));
    }

    /// Sends the digits of a keypad inside a call.
    pub fn dtmf(&self, call_id: i32, digits: &str) {
        let _ = self
            .commands
            .send(Command::Dtmf(call_id, digits.to_string()));
    }

    /// Transfers a call to a number, it is a blind transfer.
    pub fn transfer(&self, call_id: i32, target: &str) {
        let _ = self
            .commands
            .send(Command::Transfer(call_id, target.to_string()));
    }

    /// Plays or stops the ringtone of an incoming call on the sound device.
    pub fn ring(&self, on: bool) {
        let _ = self.commands.send(Command::Ring(on));
    }

    /// Stops the engine, the thread of pjsua ends.
    pub fn shutdown(&self) {
        let _ = self.commands.send(Command::Shutdown);
    }
}
