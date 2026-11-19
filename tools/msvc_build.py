#!/usr/bin/env python3
"""Builds a Visual Studio project with cl.exe, without msbuild.

    python3 tools/msvc_build.py --project <vcxproj> --configuration Release
                                 --platform Win32 [--out <file.lib|file.exe>]
                                 [--merge <lib> <lib> ...]

Why: msbuild cannot be run under Wine, so the projects of the tree are built
with the compiler itself. The script reads the include paths, the defines, the
runtime and the source list out of the project and its property sheets, so the
result is the same as the project built by Visual Studio.

The property sheets are evaluated with the configuration and the platform, the
same way msbuild does it: an import inside a PropertyGroup with a matching
condition is read, everything else is ignored.
"""
import argparse
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.microsoft.com/developer/msbuild/2003'}


def tag(e):
    return e.tag.split('}')[-1]


def children(e, name):
    return [c for c in e if tag(c) == name]


def text_of(e):
    return (e.text or '').strip() if e is not None else ''


class Condition:
    """Just enough of the msbuild condition syntax for these projects."""

    def __init__(self, props):
        self.props = props

    def expand(self, s):
        def repl(m):
            return self.props.get(m.group(1), '')
        return re.sub(r'\$\((\w+)\)', repl, s)

    def eval(self, expr):
        if expr is None:
            return True
        expr = expr.strip()
        if not expr:
            return True
        if expr.startswith('exists('):
            path = expr[7:-1].strip("'")
            return os.path.exists(self.expand(path))
        # "a"=='b' and "c"!='d', the "or" parts are alternatives
        for alternative in re.split(r'\s+or\s+', expr, flags=re.I):
            if self._eval_and(alternative):
                return True
        return False

    def _eval_and(self, expr):
        for part in re.split(r'\s+and\s+', expr, flags=re.I):
            part = part.strip()
            # 'left'=='right', left==right, 'left'!='' and the like
            m = re.match(r"^\s*'?(.*?)'?\s*(==|!=)\s*'?(.*?)'?\s*$", part)
            if not m:
                raise ValueError('cannot evaluate condition: %s' % expr)
            left = self.expand(m.group(1).strip())
            op = m.group(2)
            right = m.group(3).strip()
            if op == '==':
                if left != right:
                    return False
            else:
                if left == right:
                    return False
        return True


class Project:
    def __init__(self, path, configuration, platform):
        self.path = os.path.abspath(path)
        self.dir = os.path.dirname(self.path)
        self.configuration = configuration
        self.platform = platform
        self.props = {'Configuration': configuration, 'Platform': platform,
                      'ProjectDir': self.dir + os.sep, 'ProjectName': os.path.splitext(os.path.basename(self.path))[0]}
        self.item_groups = []
        self.definitions = []      # list of ItemDefinitionGroup elements
        self._seen = set()
        self._load(self.path, self._seen)

    def _load(self, path, seen):
        path = os.path.abspath(path)
        if path in seen or not os.path.isfile(path):
            return
        seen.add(path)
        tree = ET.parse(path)
        root = tree.getroot()
        cond = Condition(self.props)

        # the children are read in the order of the file, that is the order
        # msbuild evaluates them in
        for node in root:
            name = tag(node)
            c = node.get('Condition')
            if c and not cond.eval(c):
                continue
            if name == 'Import':
                self._import_child(node, cond, path)
            elif name == 'ImportGroup':
                for imp in children(node, 'Import'):
                    self._import_child(imp, cond, path)
            elif name == 'Choose':
                self._choose(node, cond, path)
            elif name == 'PropertyGroup':
                for child in node:
                    cc = child.get('Condition')
                    if cc and not cond.eval(cc):
                        continue
                    if tag(child) == 'Import':
                        self._import_child(child, cond, path)
                        continue
                    self.props[tag(child)] = (child.text or '').strip()
            elif name == 'ItemDefinitionGroup':
                self.definitions.append(node)
            elif name == 'ItemGroup':
                self.item_groups.append(node)

    def _import_child(self, imp, cond, path):
        p = imp.get('Project', '')
        if not p or p.startswith('$('):
            return
        # the projects use windows paths
        p = p.replace('\\', '/')
        full = os.path.normpath(os.path.join(os.path.dirname(path), p))
        if full in self._seen or not os.path.isfile(full):
            return
        self._load(full, self._seen)

    def _choose(self, choose, cond, path):
        """<Choose> blocks, the first <When> that matches wins."""
        chosen = None
        for when in children(choose, 'When'):
            if cond.eval(when.get('Condition', '')):
                chosen = when
                break
        if chosen is None:
            otherwise = children(choose, 'Otherwise')
            chosen = otherwise[0] if otherwise else None
        if chosen is None:
            return
        for node in chosen:
            name = tag(node)
            c = node.get('Condition')
            if c and not cond.eval(c):
                continue
            if name == 'Import':
                self._import_child(node, cond, path)
            elif name == 'PropertyGroup':
                for child in node:
                    cc = child.get('Condition')
                    if cc and not cond.eval(cc):
                        continue
                    if tag(child) == 'Import':
                        self._import_child(child, cond, path)
                        continue
                    self.props[tag(child)] = (child.text or '').strip()
            elif name == 'ItemDefinitionGroup':
                self.definitions.append(node)
            elif name == 'Choose':
                self._choose(node, cond, path)

    def items(self, name):
        """The items of the project, the ones that are excluded from the build
        are left out."""
        out = []
        cond = Condition(self.props)
        for group in self.item_groups:
            for item in children(group, name):
                c = item.get('Condition')
                if c and not cond.eval(c):
                    continue
                excluded = False
                for e in children(item, 'ExcludedFromBuild'):
                    c = e.get('Condition')
                    if c and not cond.eval(c):
                        continue
                    if (e.text or '').strip().lower() == 'true':
                        excluded = True
                if excluded:
                    continue
                out.append(item.get('Include'))
        return out

    def setting(self, section, name, default=''):
        """The value of a setting.

        The item definition groups are merged the way msbuild merges them:
        the last group wins, and "%(name)" stands for the value the groups
        before it produced.
        """
        cond = Condition(self.props)
        value = default
        for group in self.definitions:
            sec = None
            for c in children(group, section):
                sec = c
            if sec is None:
                continue
            for item in children(sec, name):
                c = item.get('Condition')
                if c and not cond.eval(c):
                    continue
                raw = (item.text or '').strip()
                raw = raw.replace('%%(%s)' % name, value)
                value = cond.expand(raw)
        return value

    def list_setting(self, section, name):
        raw = self.setting(section, name)
        cond = Condition(self.props)
        parts = []
        for p in raw.split(';'):
            p = p.strip()
            if not p or p.startswith('%(') or p.startswith('$('):
                continue
            parts.append(cond.expand(p))
        return parts


def msvc_paths(root, platform='Win32'):
    """The include and library folders of the unpacked Visual Studio.

    <root>/VC/Tools/MSVC/<version>/include          the compiler
    <root>/VC/Tools/MSVC/<version>/lib/<arch>        the compiler libraries
    <root>/VC/Tools/MSVC/<version>/atlmfc/...        MFC
    <root>/Windows Kits/10/Include/<version>/...     the sdk
    <root>/Windows Kits/10/Lib/<version>/...         the sdk libraries
    """
    inc = []
    lib = []
    arch = 'x86' if platform in ('Win32', 'x86') else 'x64'
    vcroot = os.path.join(root, 'VC', 'Tools', 'MSVC')
    if os.path.isdir(vcroot):
        for version in sorted(os.listdir(vcroot)):
            base = os.path.join(vcroot, version)
            inc.append(os.path.join(base, 'include'))
            lib.append(os.path.join(base, 'lib', arch))
            mfc = os.path.join(base, 'atlmfc')
            if os.path.isdir(mfc):
                inc.append(os.path.join(mfc, 'include'))
                lib.append(os.path.join(mfc, 'lib', arch))
    # the sdk is in "Windows Kits" in a visual studio installation and in
    # "kits" in the msvc-wine toolchain
    kits = None
    for candidate in (os.path.join(root, 'Windows Kits', '10'), os.path.join(root, 'kits', '10')):
        if os.path.isdir(candidate):
            kits = candidate
            break
    if kits:
        for sub in os.listdir(kits):
            base = os.path.join(kits, sub)
            if not os.path.isdir(base):
                continue
            low = sub.lower()
            if low == 'include':
                for version in sorted(os.listdir(base)):
                    for part in ('ucrt', 'um', 'shared', 'winrt', 'cppwinrt'):
                        d = os.path.join(base, version, part)
                        if os.path.isdir(d):
                            inc.append(d)
            elif low == 'lib':
                for version in sorted(os.listdir(base)):
                    for part in ('ucrt', 'um'):
                        d = os.path.join(base, version, part, arch)
                        if os.path.isdir(d):
                            lib.append(d)
    return [d for d in inc if os.path.isdir(d)], [d for d in lib if os.path.isdir(d)]


def arg(flag, path):
    """A command line argument with a path, quoted when it has spaces."""
    p = win_path(path)
    if ' ' in p:
        return flag + '"' + p + '"'
    return flag + p


def win_path(p):
    """A path the windows tools understand.

    The compiler runs on windows: under wine the drive Z: is the linux root,
    so /work/pjlib becomes Z:\\work\\pjlib.
    """
    p = str(p)
    if os.name == 'nt' or not p.startswith('/'):
        return p.replace('/', '\\') if os.name == 'nt' else p
    return 'Z:' + p.replace('/', '\\')


def run(cmd, cwd=None):
    if os.environ.get('MSVC_BUILD_VERBOSE'):
        print('  $ ' + ' '.join(cmd))
    else:
        print('  $ ' + ' '.join(cmd[:6]) + (' ...' if len(cmd) > 6 else ''))
    r = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = r.stdout.decode('utf-8', 'replace')
    if out.strip():
        print('\n'.join(out.splitlines()[-25:]))
    if r.returncode != 0:
        print('FAILED: ' + ' '.join(cmd[:6]))
        sys.exit(r.returncode)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', required=True)
    ap.add_argument('--configuration', required=True)
    ap.add_argument('--platform', default='Win32')
    ap.add_argument('--out', help='the library or the exe to produce')
    ap.add_argument('--merge', nargs='*', help='libraries to merge into --out')
    ap.add_argument('--msvc', default=os.environ.get('MSVC_ROOT', '/opt/msvc'))
    ap.add_argument('--objdir', default=None)
    ap.add_argument('--define', action='append', default=[], help='extra define')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    proj = Project(args.project, args.configuration, args.platform)
    machine = 'X86' if args.platform in ('Win32', 'x86') else 'X64'

    sources = [s for s in proj.items('ClCompile') if s and s.lower().endswith(('.c', '.cpp'))]
    rc_files = [s for s in proj.items('ResourceCompile') if s and s.lower().endswith('.rc')]
    print('project %s (%s|%s): %d source(s), %d resource(s)'
          % (os.path.basename(args.project), args.configuration, args.platform, len(sources), len(rc_files)))

    inc_dirs = []
    # the paths can hold msbuild macros
    macros = {'Platform': args.platform, 'Configuration': args.configuration,
              'PlatformToolset': proj.props.get('BuildToolset', ''),
              'ProjectDir': proj.dir + os.sep}
    for d in proj.list_setting('ClCompile', 'AdditionalIncludeDirectories'):
        for name, value in macros.items():
            d = d.replace('$(%s)' % name, value)
        inc_dirs.append(os.path.normpath(os.path.join(proj.dir, d.replace('\\', '/'))))
    defs = proj.list_setting('ClCompile', 'PreprocessorDefinitions')
    # msbuild adds the character set defines itself
    if proj.props.get('CharacterSet') == 'Unicode':
        defs += ['UNICODE', '_UNICODE']
    defs += args.define

    runtime = proj.setting('ClCompile', 'RuntimeLibrary', 'MultiThreadedDLL')
    runtime_flag = {'MultiThreaded': '/MT', 'MultiThreadedDebug': '/MTd',
                    'MultiThreadedDLL': '/MD', 'MultiThreadedDebugDLL': '/MDd'}.get(runtime, '/MT')
    optimization = {'MaxSpeed': '/O2', 'Full': '/O2', 'Disabled': '/Od',
                    'MinSpace': '/O1', 'MaxSize': '/Os'}.get(proj.setting('ClCompile', 'Optimization', 'MaxSpeed'), '/O2')
    language = proj.setting('ClCompile', 'LanguageStandard', '')
    lang_flag = {'stdcpp14': '/std:c++14', 'stdcpp17': '/std:c++17', 'stdcpp20': '/std:c++20'}.get(language.replace(' ', '').lower(), '')

    msvc_inc, msvc_lib = msvc_paths(args.msvc, args.platform)

    # the objects go into a folder of their own, not into the tree of pjproject
    objdir = args.objdir or os.path.join(os.path.dirname(proj.dir), 'obj',
                                         args.configuration + '-' + args.platform)
    os.makedirs(objdir, exist_ok=True)

    common = ['/nologo', '/c', runtime_flag, optimization, '/GS', '/EHsc', '/W3', '/D' if False else '/D']
    common = ['/nologo', '/c', runtime_flag, optimization, '/GS', '/EHsc', '/W3']
    for d in defs:
        common.append('/D' + d)
    if lang_flag:
        common.append(lang_flag)
    for d in inc_dirs + msvc_inc:
        common.append(arg('/I', d))

    if args.dry_run:
        print(' '.join(common))
        return 0

    objects = []
    for src in sources:
        # the project uses windows paths
        src = src.replace('\\', '/')
        full = os.path.normpath(os.path.join(proj.dir, src))
        obj = os.path.join(objdir, os.path.splitext(os.path.basename(src))[0] + '.obj')
        os.makedirs(os.path.dirname(obj), exist_ok=True)
        cmd = ['cl'] + common + [arg('/Fo', obj), win_path(full)]
        run(cmd, cwd=proj.dir)
        objects.append(obj)

    res_objects = []
    for rc in rc_files:
        rc = rc.replace('\\', '/')
        full = os.path.normpath(os.path.join(proj.dir, rc))
        res = os.path.join(objdir, os.path.splitext(os.path.basename(rc))[0] + '.res')
        cmd = ['rc'] + ['/nologo'] + [arg('/fo', res)]
        for d in inc_dirs + msvc_inc:
            cmd.append(arg('/I', d))
        for d in defs:
            cmd.append('/D' + d)
        cmd.append(win_path(full))
        run(cmd, cwd=proj.dir)
        res_objects.append(res)

    if args.merge:
        out = args.out
        cmd = ['lib'] + ['/nologo', arg('/OUT:', out)] + [win_path(m) for m in args.merge if os.path.isfile(m)]
        run(cmd)
        return 0

    # a static library project
    if proj.props.get('ConfigurationType') == 'StaticLibrary':
        out = args.out
        if not out:
            print('no --out given')
            return 1
        cmd = ['lib'] + ['/nologo', arg('/OUT:', out)] + [win_path(o) for o in objects + res_objects]
        run(cmd, cwd=proj.dir)
        return 0

    if not args.out:
        return 0

    lib_dirs = []
    for d in proj.list_setting('Link', 'AdditionalLibraryDirectories'):
        for name, value in macros.items():
            d = d.replace('$(%s)' % name, value)
        lib_dirs.append(os.path.normpath(os.path.join(proj.dir, d.replace('\\', '/'))))
    deps = [d for d in proj.setting('Link', 'AdditionalDependencies').split(';') if d]
    subsystem = proj.setting('Link', 'SubSystem', 'Windows')
    outdir = os.path.dirname(os.path.abspath(args.out))
    if outdir:
        os.makedirs(outdir, exist_ok=True)
    cmd = ['link'] + ['/nologo', arg('/OUT:', args.out), '/MACHINE:' + machine,
                      '/SUBSYSTEM:' + subsystem]
    # the manifest: without it the system loads the version 5 of the common
    # controls and the ordinals of the version 6 are missing
    manifests = proj.list_setting('Manifest', 'AdditionalManifestFiles')
    if manifests:
        cmd.append('/MANIFEST:EMBED')
        for m in manifests:
            cmd.append(arg('/MANIFESTINPUT:', os.path.join(proj.dir, m.replace('\\', '/'))))

    # the mfc libraries and the entry point, msbuild adds them for a mfc project
    if proj.props.get('UseOfMfc', '').lower() != 'false':
        unicode = proj.props.get('CharacterSet') == 'Unicode'
        # mfcm is the static mfc for the static runtime, the application is
        # built with /MT
        if runtime_flag == '/MT':
            mfc = 'mfcm140u' if unicode else 'mfcm140'
        else:
            mfc = 'mfcs140u' if unicode else 'mfcs140'
        cmd.append('/ENTRY:wWinMainCRTStartup' if unicode else '/ENTRY:WinMainCRTStartup')
        cmd.append(mfc + '.lib')
    if runtime_flag == '/MT':
        cmd.append('/NODEFAULTLIB:msvcrt')
    for d in lib_dirs + msvc_lib:
        cmd.append(arg('/LIBPATH:', d))
    for d in deps:
        # a library that is not in the search paths is skipped, the warning
        # keeps it visible
        found = False
        for ld in lib_dirs + msvc_lib:
            try:
                names = os.listdir(ld)
            except OSError:
                continue
            if d.lower() in [n.lower() for n in names]:
                found = True
                break
        if found:
            cmd.append(d)
        else:
            print('  warning: %s not found, it is skipped' % d)
    cmd += [win_path(o) for o in objects + res_objects]
    run(cmd, cwd=proj.dir)
    return 0


if __name__ == '__main__':
    sys.exit(main())
