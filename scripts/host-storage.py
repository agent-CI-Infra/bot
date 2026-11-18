#!/usr/bin/env python3
"""Publish an atomic, path-free snapshot from the Linux host mount namespace."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def snapshot():
    if Path('/.dockerenv').exists() or Path('/run/.containerenv').exists():
        raise ValueError('run the sampler on the Docker host')
    mounts = Path('/proc/self/mountinfo').read_text().splitlines()
    return dict(version=1, boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                measured_at=datetime.now(timezone.utc).isoformat(), filesystems=local_filesystems(mounts))


def local_filesystems(mounts):
    devices = {}
    root_verified = False
    for line in mounts:
        mount, fs = line.split(' - ', 1)
        fields = mount.split()
        kind, source = fs.split()[:2]
        if kind in ('zfs', 'btrfs', 'bcachefs'):
            raise ValueError('shared-pool accounting is unavailable for ' + kind)
        if not source.startswith('/dev/') or source.startswith('/dev/loop') or kind in ('iso9660', 'squashfs', 'tmpfs', 'devtmpfs'):
            continue
        target = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[4])
        if target == '/' and fields[3] == '/':
            root_verified = True
        device = os.stat(target).st_dev
        if fields[2] != f'{os.major(device)}:{os.minor(device)}':
            raise ValueError('mount inventory changed during sampling')
        if device not in devices:
            stat = os.statvfs(target)
            fsid = subprocess.check_output(['stat', '-f', '-c', '%i', '--', target], text=True, timeout=5).strip().lower()
            if not re.fullmatch('[a-f0-9]+', fsid) or not int(fsid, 16):
                raise ValueError('unavailable filesystem identifier')
            devices[device] = dict(device=f'{device}:{fsid}', total=stat.f_blocks * stat.f_frsize,
                                   free=stat.f_bfree * stat.f_frsize)
    if not root_verified or not devices:
        raise ValueError('could not verify the local host root filesystem')
    return list(devices.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='host metrics directory mounted read-only by Launchpad')
    directory = parser.parse_args().directory
    data = snapshot()
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', dir=directory, delete=False) as out:
        try:
            json.dump(data, out)
            out.flush()
            os.fchmod(out.fileno(), 0o644)
            os.replace(out.name, directory / 'filesystems.json')
        finally:
            Path(out.name).unlink(missing_ok=True)


if __name__ == '__main__':
    main()
