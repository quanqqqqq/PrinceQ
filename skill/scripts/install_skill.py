#!/usr/bin/env python3
"""Install this portable PrinceQ Skill for local Claude and Codex without changing config."""
from pathlib import Path
import argparse
import shutil
import sys

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true',help='report installation destinations without writing')
    args=parser.parse_args()
    source=Path(__file__).resolve().parents[1]
    destinations=[Path.home()/'.claude/skills/personal-work-queue',Path.home()/'.agents/skills/personal-work-queue']
    companion=Path.home()/'Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.user_skills/personal-work-queue'
    for destination in destinations:
        if destination.exists() or destination.is_symlink():
            if not destination.is_symlink() or destination.resolve()!=source:
                sys.exit('Refusing to replace an existing unrelated skill: '+str(destination))
    for destination in destinations:
        if not args.check:
            destination.parent.mkdir(parents=True,exist_ok=True)
            if not destination.is_symlink():destination.symlink_to(source,target_is_directory=True)
        print(('CHECK ' if args.check else 'INSTALLED ')+str(destination))
    if companion.exists():
        if not args.check:
            for rel in ['SKILL.md','references/api-reference.md','references/operations.md','references/scoring.md','scripts/pwq_client.py','scripts/install_skill.py']:
                target=companion/rel
                target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copy2(source/rel,target)
        print(('CHECK ' if args.check else 'SYNCED ')+str(companion))

if __name__=='__main__':main()
