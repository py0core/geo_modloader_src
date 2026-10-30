#!/usr/bin/env python3
"""Geoplanetical Mod Loader - installer / launcher (Python 3.8+, standard library only).

    python loader.py              make sure the game is hooked, then start it   (default)
    python loader.py patch        hook the game, don't start it
    python loader.py restore      put the original game files back
    python loader.py status       show what state the game files are in
    --safe                        start the game with mods disabled (this run only)
    --retry-native                try the sealed loader's key module again after a crash

What "hook" means: the game's electron/main.js gets ONE extra line at the top that loads
ModLoader/runtime/core.js. Everything else (mods, UI, patches) lives outside the game archive, so mods can be
added/removed/toggled without touching the game again. The hook is made to fit inside main.js's existing space
(by dropping its leading comment lines), so the archive's header keeps its exact length and only a few KB are
rewritten. Electron's asar integrity check is satisfied by updating the hash stored in Geoplanetical.exe.
A Steam update restores the original files; just run this again (it takes a second).
"""
import hashlib, json, os, re, struct, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GAME = HERE.parent
BACKUP = HERE / 'backup'
BLOCK = 4 * 1024 * 1024
MARK = b'/*GEOMOD*/'
HOOK = (b"/*GEOMOD*/try{require(process.env.GEOMOD_CORE||require('path').join(process.execPath,'..','ModLoader','runtime','core.js'))}catch(_e){}\n")
EXE_RE = re.compile(rb'("file":"resources\\\\app\.asar","alg":"SHA256","value":")([0-9a-f]{64})(")')

def align4(n): return (n + 3) & ~3
def sha(b): return hashlib.sha256(b).hexdigest()
def die(msg): print('ERROR: ' + msg); sys.exit(1)

class Asar:
    def __init__(self, path):
        self.path = Path(path)
        with open(self.path, 'rb') as f:
            a, b, c, jl = struct.unpack('<IIII', f.read(16))
            self.json = f.read(jl)
        if not (a == 4 and b == align4(jl) + 8 and c == align4(jl) + 4): die('unexpected app.asar header layout (unsupported game version?)')
        self.jl, self.data_start = jl, 8 + b
        self.header = json.loads(self.json)
        if json.dumps(self.header, separators=(',', ':'), ensure_ascii=False).encode().rstrip() != self.json.rstrip():
            die('app.asar header does not round-trip; unsupported layout')
        self.hash = sha(self.json)
    def entry(self, rel):
        n = self.header
        for p in rel.split('/'): n = n['files'][p]
        return n
    def read_region(self, e):
        with open(self.path, 'rb') as f:
            f.seek(self.data_start + int(e['offset'])); return f.read(e['size'])

def integrity(data):
    return {'algorithm': 'SHA256', 'hash': sha(data), 'blockSize': BLOCK,
            'blocks': [sha(data[i:i + BLOCK]) for i in range(0, max(len(data), 1), BLOCK)]}

def header_json(header, length):
    js = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode()
    if len(js) > length: die('patched header would not fit the original header length')
    return js + b' ' * (length - len(js))               # JSON allows trailing whitespace; keeps every offset unchanged

def fit_hook(orig):
    """Return main.js with the hook prepended, no longer than the original."""
    text = orig.decode('utf-8')
    lines = text.split('\n')
    i = 0
    while len(HOOK) + len('\n'.join(lines[i:]).encode('utf-8')) > len(orig):
        if i >= len(lines) or not (lines[i].lstrip().startswith('//') or not lines[i].strip()):
            die('cannot fit the hook into main.js (no leading comment lines left to drop)')
        i += 1
    return HOOK + '\n'.join(lines[i:]).encode('utf-8')

def exe_value(exe_bytes):
    m = EXE_RE.findall(exe_bytes)
    if len(m) != 1: die('could not find the asar integrity hash in Geoplanetical.exe exactly once (unsupported game version)')
    return m[0][1].decode()

def set_exe_value(exe, new):
    data = exe.read_bytes()
    old = exe_value(data)
    if old == new: return False
    pos = EXE_RE.search(data).start(2)
    with open(exe, 'r+b') as f: f.seek(pos); f.write(new.encode())
    return True

def paths(game):
    return game / 'resources' / 'app.asar', game / 'Geoplanetical.exe'

NATIVE_MARK = HERE / 'runtime' / '.native-loading'

def native_note(retry=False):
    """The sealed loader writes this marker while it loads its key module and removes it right after. If it is still there, the
    previous start died inside the key module, so the loader stays off (instead of crashing the game every time)."""
    sealed = (HERE / 'runtime' / 'core.sealed').exists()
    if NATIVE_MARK.exists():
        if retry:
            NATIVE_MARK.unlink(); print('retrying the key module')
        else:
            print('NOTE: the previous start crashed while loading the loader key module, so mods are OFF.')
            print('      Run again with  --retry-native  to try once more (or tell the loader author).')
    return sealed

def cmd_status(game):
    asar_p, exe_p = paths(game)
    a = Asar(asar_p); e = a.entry('electron/main.js')
    hooked = a.read_region(e).startswith(MARK)
    print('hooked          :', hooked)
    print('exe hash ok     :', exe_value(exe_p.read_bytes()) == a.hash)
    print('core present    :', (HERE / 'runtime' / 'core.js').exists())
    print('backup          :', (BACKUP / 'meta.json').exists())
    print('loader sealed   :', native_note())
    return hooked

def cmd_patch(game):
    asar_p, exe_p = paths(game)
    a = Asar(asar_p)
    if 'gemini-bridge.js' in a.header['files']['electron']['files']:
        die('app.asar carries the OLD in-place mod. Restore the original first (Steam > Properties > Installed Files > Verify integrity), then run this again.')
    e = a.entry('electron/main.js')
    region = a.read_region(e)
    hooked = region.startswith(MARK)
    exe_before = exe_value(exe_p.read_bytes())
    try:
        if not hooked:
            new = fit_hook(region)
            BACKUP.mkdir(exist_ok=True)
            with open(asar_p, 'rb') as f: (BACKUP / 'asar-header.bin').write_bytes(f.read(a.data_start))
            (BACKUP / 'main.js.orig').write_bytes(region)
            (BACKUP / 'meta.json').write_text(json.dumps({'orig_header_sha': a.hash, 'exe_value': exe_before, 'main_offset': int(e['offset']),
                'main_size': e['size'], 'patched_header_sha': None}))
            e['size'] = len(new); e['integrity'] = integrity(new)
            hdr = header_json(a.header, a.jl)
            with open(asar_p, 'r+b') as f:
                f.seek(a.data_start + int(e['offset'])); f.write(new)           # 1) file bytes
                f.seek(16); f.write(hdr)                                        # 2) header (same length)
            meta = json.loads((BACKUP / 'meta.json').read_text()); meta['patched_header_sha'] = sha(hdr)
            (BACKUP / 'meta.json').write_text(json.dumps(meta))
            changed = 'hooked main.js'
        else:
            body = region[:e['size']]
            if e['integrity'] != integrity(body):                               # heal an interrupted run
                e['integrity'] = integrity(body)
                with open(asar_p, 'r+b') as f: f.seek(16); f.write(header_json(a.header, a.jl))
                changed = 'repaired header'
            else: changed = 'already hooked'
        a2 = Asar(asar_p)
        if set_exe_value(exe_p, a2.hash): changed += ', updated exe hash'
    except PermissionError:
        die('cannot write game files - close the game (and anything using it), then retry.')
    print(changed)

def cmd_restore(game):
    asar_p, exe_p = paths(game)
    try: meta = json.loads((BACKUP / 'meta.json').read_text())
    except Exception: die('no backup found. Use Steam > Verify integrity of game files.')
    a = Asar(asar_p)
    if a.hash != meta.get('patched_header_sha') and a.hash != meta['orig_header_sha']:
        die('app.asar is not the file this loader patched (the game was probably updated, so it is already original).')
    try:
        with open(asar_p, 'r+b') as f:
            orig = (BACKUP / 'main.js.orig').read_bytes()
            f.seek(a.data_start + meta['main_offset']); f.write(orig)
            f.seek(0); f.write((BACKUP / 'asar-header.bin').read_bytes())
        set_exe_value(exe_p, meta['exe_value'])
    except PermissionError:
        die('cannot write game files - close the game first.')
    print('restored the original game files')

def cmd_launch(game, args, safe, retry=False):
    _, exe_p = paths(game)
    cmd_patch(game)
    native_note(retry)
    env = dict(os.environ)
    try: env.setdefault('SteamAppId', str(json.loads(Asar(game / 'resources' / 'app.asar').read_region(Asar(game / 'resources' / 'app.asar').entry('package.json')))['steam']['appId']))
    except Exception: pass
    if safe: args = args + ['--geomod-off']
    print('starting Geoplanetical' + (' (mods off)' if safe else '') + ' ...')
    return subprocess.call([str(exe_p)] + args, cwd=str(game), env=env)

def main(argv):
    args = [a for a in argv if not a.lower().endswith('geoplanetical.exe')]     # Steam's %command%
    safe = '--safe' in args; args = [a for a in args if a != '--safe']
    retry = '--retry-native' in args; args = [a for a in args if a != '--retry-native']
    verb = args[0] if args and args[0] in ('launch', 'patch', 'restore', 'status') else 'launch'
    if args and args[0] == verb: args = args[1:]
    game = Path(os.environ.get('GEOMOD_GAME', GAME))
    if verb == 'status': cmd_status(game)
    elif verb == 'patch': cmd_patch(game)
    elif verb == 'restore': cmd_restore(game)
    else: return cmd_launch(game, args, safe, retry)
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
