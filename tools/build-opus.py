#!/usr/bin/env python3
"""Builds the opus library with cl.exe.

    python3 tools/build-opus.py <opus folder> <output lib> [--msvc /opt/msvc]

The source list comes from the makefiles of opus (the same ones the cmake
build uses), the floating point sources are compiled with OPUS_FLOAT. cmake is
not needed, and the build works the same under wine.
"""
import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from opus_sources import sources  # noqa: E402

LISTS = [
    ('opus_sources.mk', 'OPUS_SOURCES', False),
    ('opus_sources.mk', 'OPUS_SOURCES_FLOAT', True),
    ('celt_sources.mk', 'CELT_SOURCES', False),
    ('celt_sources.mk', 'CELT_SOURCES_FLOAT', True),
    ('silk_sources.mk', 'SILK_SOURCES', False),
    ('silk_sources.mk', 'SILK_SOURCES_FLOAT', True),
]


def win_path(p):
    if os.name == 'nt':
        return p.replace('/', '\\')
    if p.startswith('/'):
        return 'Z:' + p.replace('/', '\\')
    return p


def run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = r.stdout.decode('utf-8', 'replace').strip()
    if r.returncode != 0:
        print(out[-3000:])
        print('FAILED: ' + cmd[0])
        sys.exit(r.returncode)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('opus')
    ap.add_argument('out')
    ap.add_argument('--objdir', default=None)
    args = ap.parse_args()

    opus = os.path.abspath(args.opus)
    objdir = args.objdir or os.path.join(os.path.dirname(args.out), 'opus')
    os.makedirs(objdir, exist_ok=True)

    # the configuration opus expects, the cmake build writes the same
    with open(os.path.join(opus, 'config.h'), 'w') as f:
        f.write('#define PACKAGE_VERSION "1.5.2"\n')

    incs = [opus,
            os.path.join(opus, 'include'),
            os.path.join(opus, 'src'),
            os.path.join(opus, 'celt'),
            os.path.join(opus, 'silk'),
            os.path.join(opus, 'silk', 'fixed'),
            os.path.join(opus, 'silk', 'float')]

    objects = []
    for mk, var, is_float in LISTS:
        path = os.path.join(opus, mk)
        if not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8', errors='replace') as f:
            for src in sources(f.read(), var):
                full = os.path.join(opus, src)
                name = src.replace('/', '_').rsplit('.', 1)[0]
                if is_float:
                    name += '_float'
                obj = os.path.join(objdir, name + '.obj')
                cmd = ['cl', '/nologo', '/c', '/MT', '/O2', '/GS', '/W3',
                       '/DOPUS_BUILD', '/DHAVE_CONFIG_H',
                       # msvis has no variable length arrays, the cmake build
                       # uses the same choice
                       '/DUSE_ALLOCA']
                if is_float:
                    cmd.append('/DOPUS_FLOAT')
                for i in incs:
                    cmd.append('/I' + win_path(i))
                cmd.append('/Fo' + win_path(obj))
                cmd.append(win_path(full))
                run(cmd)
                objects.append(obj)
                print('  ' + src)

    cmd = ['lib', '/nologo', '/OUT:' + win_path(args.out)] + [win_path(o) for o in objects]
    run(cmd)
    print('opus: ' + args.out)


if __name__ == '__main__':
    main()
