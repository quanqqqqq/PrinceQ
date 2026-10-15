#!/usr/bin/env python3
"""Install PrinceQ for Claude and Codex; Windows uses permission-free copies."""
from pathlib import Path
import argparse
import json
import os
import shutil
import sys
import tempfile

MARKER = '.princeq-install.json'


def check_destination(destination, source):
    if destination.is_symlink():
        if destination.resolve() != source:
            raise ValueError('Refusing to replace an unrelated link: ' + str(destination))
    elif destination.exists():
        marker = destination / MARKER
        try:
            owned = json.loads(marker.read_text(encoding='utf-8')).get('skill') == 'personal-work-queue'
        except (OSError, ValueError):
            owned = False
        if not owned:
            raise ValueError('Refusing to replace an existing unrelated skill: ' + str(destination))


def install(source, destination, mode):
    check_destination(destination, source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        return  # Existing links to this source are already up to date.
    if mode == 'link' and not destination.exists():
        destination.symlink_to(source, target_is_directory=True)
        return
    # Stage a complete copy before replacing an earlier managed installation.
    with tempfile.TemporaryDirectory(prefix='princeq-install-', dir=destination.parent) as temporary:
        staged = Path(temporary) / 'skill'
        shutil.copytree(source, staged, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', MARKER))
        (staged / MARKER).write_text(json.dumps({'skill': 'personal-work-queue', 'source': str(source)}), encoding='utf-8')
        backup = Path(temporary) / 'previous'
        if destination.exists():
            destination.rename(backup)
        try:
            staged.rename(destination)
        except OSError:
            if backup.exists():
                backup.rename(destination)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='report destinations without writing')
    parser.add_argument('--mode', choices=['auto', 'copy', 'link'], default='auto')
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    mode = ('copy' if os.name == 'nt' else 'link') if args.mode == 'auto' else args.mode
    destinations = [Path.home()/'.claude/skills/personal-work-queue', Path.home()/'.agents/skills/personal-work-queue']
    try:
        for destination in destinations:
            check_destination(destination, source)
        for destination in destinations:
            if not args.check:
                install(source, destination, mode)
            print(('CHECK ' if args.check else 'INSTALLED ') + str(destination) + ' (' + mode + ')')
        if sys.platform == 'darwin':
            companion = Path.home()/'Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.user_skills/personal-work-queue'
            if companion.exists() and companion.resolve() != source:
                if not args.check:
                    for rel in ['SKILL.md', 'references/api-reference.md', 'references/operations.md', 'references/scoring.md', 'scripts/pwq_client.py', 'scripts/install_skill.py']:
                        target = companion/rel
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source/rel, target)
                print(('CHECK ' if args.check else 'SYNCED ') + str(companion))
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
