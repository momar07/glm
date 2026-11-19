use std::path::PathBuf;

/// The bindings of pjsua, the C api of pjproject.
///
/// The library is built for windows x64 by tools/build-pjproject.sh, it lands
/// in third_party/pjproject-win-x64. The headers are the ones of the same
/// build, the bindings have to match the library exactly.
fn main() {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let pj = root.join("third_party/pjproject-win-x64");
    let lib = pj.join("lib");
    let inc = pj.join("include");

    let include_dirs = [
        inc.join("pjlib/include"),
        inc.join("pjlib-util/include"),
        inc.join("pjmedia/include"),
        inc.join("pjmedia/src"),
        inc.join("pjnath/include"),
        inc.join("pjsip/include"),
        inc.join("pjsip/src"),
    ];
    for dir in &include_dirs {
        if !dir.is_dir() {
            panic!(
                "the headers of pjproject are missing: {}\nrun tools/build-pjproject.sh",
                dir.display()
            );
        }
    }
    for file in [
        "libpjproject-x64-Win32-vc14-Release-Static.lib",
        "bcg729.lib",
        "opus.lib",
    ] {
        if !lib.join(file).is_file() {
            panic!(
                "the library of pjproject is missing: {}\nrun tools/build-pjproject.sh",
                lib.join(file).display()
            );
        }
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", inc.display());
    println!("cargo:rustc-link-search=native={}", lib.display());
    // the library of pjproject is static, the order is the one of the
    // dependencies: the codecs, then pjmedia, then pjsip
    println!("cargo:rustc-link-lib=static=libpjproject-x64-Win32-vc14-Release-Static");
    println!("cargo:rustc-link-lib=static=bcg729");
    println!("cargo:rustc-link-lib=static=opus");
    // the socket library of windows
    println!("cargo:rustc-link-lib=ws2_32");
    println!("cargo:rustc-link-lib=user32");
    println!("cargo:rustc-link-lib=winmm");
    // pjproject asks for the guid of the session
    println!("cargo:rustc-link-lib=ole32");

    let mut builder = bindgen::Builder::default()
        .header_contents(
            "wrapper.h",
            "#include <pjsua-lib/pjsua.h>\n#include <pjlib.h>\n",
        )
        .allowlist_function("pjsua_.*")
        .allowlist_function("pjmedia_tonegen_.*")
        .allowlist_function("pj_(str|cstr|strdup2)$")
        .allowlist_function("pj_pool_create$")
        .allowlist_function("pj_caching_pool_init$")
        .allowlist_recursively(true)
        .size_t_is_usize(true)
        .generate_comments(false)
        .layout_tests(false)
        .derive_default(false);

    // bindgen needs the shared library of clang, it is not always in the path
    if std::env::var_os("LIBCLANG_PATH").is_none() {
        for dir in [
            "/usr/lib64/llvm21/lib64",
            "/usr/lib/llvm-21/lib",
            "/usr/lib/x86_64-linux-gnu",
            "/usr/lib64",
        ] {
            if PathBuf::from(dir).join("libclang.so.1").exists()
                || PathBuf::from(dir).join("libclang.so").exists()
            {
                // the path is read by the clang crate, it is not a rust one
                unsafe { std::env::set_var("LIBCLANG_PATH", dir) };
                break;
            }
        }
    }

    for dir in &include_dirs {
        builder = builder.clang_arg(format!("-I{}", dir.display()));
    }

    let bindings = builder
        .generate()
        .expect("the bindings of pjsua could not be made");

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("pjsua.rs");
    bindings
        .write_to_file(&out)
        .expect("the bindings of pjsua could not be written");
}
