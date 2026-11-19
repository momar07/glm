#!/usr/bin/env python3
"""Prints the source list of the opus library.

    python3 tools/opus_sources.py <opus folder>

The lists are in the makefiles of opus, the same ones the cmake build uses.
The sources of the floating point variant are marked with "FLOAT", they are
compiled with OPUS_FLOAT.
"""
import os
import re
import sys

LISTS = [
    ('opus_sources.mk', 'OPUS_SOURCES', False),
    ('opus_sources.mk', 'OPUS_SOURCES_FLOAT', True),
    ('celt_sources.mk', 'CELT_SOURCES', False),
    ('silk_sources.mk', 'SILK_SOURCES', False),
]


def sources(text, var):
    m = re.search(r'^%s\s*=\s*(.*?)(?<!\\)\n' % re.escape(var), text, re.M | re.S)
    if not m:
        return []
    body = m.group(1).replace('\\\n', ' ')
    return [s for s in body.split() if s.endswith('.c')]


def main():
    root = sys.argv[1]
    for mk, var, is_float in LISTS:
        path = os.path.join(root, mk)
        if not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8', errors='replace') as f:
            for src in sources(f.read(), var):
                print(('FLOAT ' if is_float else '') + src)


if __name__ == '__main__':
    main()
