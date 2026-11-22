"""Compare immutable official SDK artifacts and prove a complete-tree delta."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tarfile

BASE = Path('sdk-delta-work')
OUT = Path('sdk-export')
OUT.mkdir(exist_ok=True)
BASE.mkdir(exist_ok=True)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def manifest(base, roots):
    rows = []
    for root in roots:
        for path in sorted([base / root, *(base / root).rglob('*')]):
            st = path.lstat()
            row = {'path': path.relative_to(base).as_posix(), 'mode': stat.S_IMODE(st.st_mode)}
            if path.is_symlink():
                row.update(type='symlink', target=os.readlink(path))
            elif path.is_dir():
                row.update(type='directory')
            elif path.is_file():
                row.update(type='file', bytes=st.st_size, sha256=digest(path))
            else:
                raise ValueError(str(path))
            rows.append(row)
    return sorted(rows, key=lambda row: row['path'])


def unpack(label, worker, expected_hash):
    source = Path('sdk-' + label)
    verdict = json.loads((source / 'native-verdict.json').read_text())
    assert verdict['workerSource'] == worker
    assert verdict['coreSource'] == '32e43f216d5b85057db9a55106fa930473f1c959'
    archive = source / 'openclaw-sdk-runtime.tar.gz'
    actual = digest(archive)
    assert actual == expected_hash
    assert (source / 'openclaw-sdk-runtime.tar.gz.sha256').read_text().split()[0] == actual
    roots = json.loads((source / 'output-roots.json').read_text())
    destination = BASE / label
    destination.mkdir()
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            assert not member.name.startswith('/') and '..' not in Path(member.name).parts
            assert any(member.name == root or member.name.startswith(root + '/') for root in roots)
        tar.extractall(destination, filter='data')
    return destination, roots, archive.stat().st_size


cached = json.loads(Path('.github/scripts/cached-sdk-full-manifest.json').read_text())
old_hash = Path('sdk-old/openclaw-sdk-runtime.tar.gz.sha256').read_text().split()[0]
old, roots, old_size = unpack('old', 'd30a7b434dddb1d161be704b9a607c80a1ffe455', old_hash)
new, new_roots, new_size = unpack('new', '0c93456e90a5f1d732dbc4f2fd506728e4a0b088',
                               '910aacca14c699fce8c5fe7f8b62eee575458ac2c7e3b95790cef3218f367037')
assert roots == new_roots == cached['roots']
old_rows = manifest(old, roots)
assert old_rows == cached['entries'], 'Cached local SDK differs from old immutable artifact'
new_rows = manifest(new, roots)
old_map = {row['path']: row for row in old_rows}
new_map = {row['path']: row for row in new_rows}
changed = [row for row in new_rows if row != old_map.get(row['path'])]
removed = sorted((key for key in old_map if key not in new_map), key=lambda key: (-len(Path(key).parts), key))
# Type replacement must remove the old entry before applying the new one.
replaced = [row['path'] for row in changed if row['path'] in old_map and old_map[row['path']]['type'] != row['type']]
removed = sorted(set(removed + replaced), key=lambda key: (-len(Path(key).parts), key))
delta = OUT / 'openclaw-sdk-delta.tar.gz'
with tarfile.open(delta, 'w:gz', compresslevel=6) as tar:
    for row in changed:
        tar.add(new / row['path'], arcname=row['path'], recursive=False)
# Validate exactly the same ordered delete/extract procedure against the old tree.
replay = BASE / 'replay'
shutil.copytree(old, replay, symlinks=True)
for relative in removed:
    path = replay / relative
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)
with tarfile.open(delta, 'r:gz') as tar:
    tar.extractall(replay, filter='data')
assert manifest(replay, roots) == new_rows, 'Delta replay did not reproduce complete target SDK tree'
for filename, data in [('target-manifest.json', {'roots': roots, 'entries': new_rows}),
                       ('base-manifest.json', cached), ('delete-paths.json', removed)]:
    (OUT / filename).write_text(json.dumps(data, sort_keys=True, separators=(',', ':')) + '\n')
changed_bytes = sum(row.get('bytes', 0) for row in changed)
# Conservatively count archive, one extraction and a second copy in the new image layer.
local_budget = delta.stat().st_size + 2 * changed_bytes + sum((OUT / name).stat().st_size for name in
    ['target-manifest.json', 'base-manifest.json', 'delete-paths.json']) + 10 * 1024 * 1024
verdict = {'status': 'exact_delta_verified' if local_budget <= 400 * 1024 * 1024 else 'over_budget_do_not_import',
    'baseImageId': cached['sdkImage'], 'compiledWorkerSource': '0c93456e90a5f1d732dbc4f2fd506728e4a0b088',
    'workerSource': '1fdfe651a4b10bffcdb652025e03e369cda89c43', 'nativeValidationRun': 44990572738,
    'oldArtifact': 14736621291, 'newArtifact': 14741471578,
    'oldRuntimeSHA256': old_hash, 'newRuntimeSHA256': '910aacca14c699fce8c5fe7f8b62eee575458ac2c7e3b95790cef3218f367037',
    'oldArchiveBytes': old_size, 'newArchiveBytes': new_size, 'baseEntries': len(old_rows), 'targetEntries': len(new_rows),
    'cachedBaseMatchesWholeOldArtifact': True, 'replayedCompleteTreeMatchesNewArtifact': True,
    'changedEntries': len(changed), 'deletedEntries': len(removed), 'changedFileBytes': changed_bytes,
    'deltaArchiveBytes': delta.stat().st_size, 'deltaSHA256': digest(delta), 'conservativeLocalBytes': local_budget,
    'sdkRecompiled': False, 'imagePublished': False, 'realBusinessCertification': False}
(OUT / 'delta-verdict.json').write_text(json.dumps(verdict, indent=2) + '\n')
if local_budget > 400 * 1024 * 1024:
    delta.unlink()
print(json.dumps(verdict, indent=2), flush=True)
