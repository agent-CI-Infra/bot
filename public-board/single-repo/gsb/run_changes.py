"""Bounded, nonsecret rerun hints fetched from the collector's trusted bot."""
from __future__ import annotations

import json
from pathlib import Path
import re

BATCH_SIZE = 20


def valid_change(row):
    return (isinstance(row, dict) and set(row) == {'id', 'attempt', 'revision'}
            and type(row['id']) is int and 0 < row['id'] <= 2**53 - 1
            and type(row['attempt']) is int and 1 < row['attempt'] <= 2**53 - 1
            and isinstance(row['revision'], str) and re.fullmatch('[0-9a-f]{32}', row['revision']) is not None)


def load_changes(path, source):
    if not path:
        return []
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict) or value.get('ok') is not True:
        return []  # An unavailable/older bot keeps its hints; ordinary collection can continue.
    if not isinstance(value.get('source'), str) or value['source'].lower() != source.lower():
        raise ValueError('rerun source mismatch')
    rows = value.get('runs')
    if not isinstance(rows, list) or len(rows) > BATCH_SIZE or not all(valid_change(row) for row in rows):
        raise ValueError('invalid rerun hints')
    if len({row['id'] for row in rows}) != len(rows):
        raise ValueError('duplicate rerun hints')
    return rows


def write_receipt(path, source, changes, commit):
    """Only publish.py calls this after its atomic Git update succeeded."""
    if path and changes:
        value = {'source': source, 'runs': changes, 'commit': commit}
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix('.tmp')
        temp.write_text(json.dumps(value, separators=(',', ':')))
        temp.replace(target)
