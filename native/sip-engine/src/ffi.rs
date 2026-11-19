//! The bindings of pjsua, they are made by bindgen in build.rs.

#![allow(
    non_upper_case_globals,
    non_camel_case_types,
    non_snake_case,
    dead_code
)]

include!(concat!(env!("OUT_DIR"), "/pjsua.rs"));
