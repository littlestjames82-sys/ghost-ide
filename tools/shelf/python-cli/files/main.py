#!/usr/bin/env python3
"""{{name}} - a command-line tool.

Run: python3 main.py --help
"""
import argparse


def main():
    ap = argparse.ArgumentParser(prog="{{name}}")
    ap.add_argument("--shout", action="store_true",
                    help="uppercase the greeting")
    args = ap.parse_args()
    msg = "hello from {{name}}"
    print(msg.upper() if args.shout else msg)


if __name__ == "__main__":
    main()
