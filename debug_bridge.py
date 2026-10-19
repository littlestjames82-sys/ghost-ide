#!/usr/bin/env python3
"""GhostIDE debug bridge (Roadmap G7).

Runs a target Python file under a bdb-based debugger and
speaks JSON lines: commands arrive on stdin, events leave on
stdout. The IDE server owns the process per session.

Commands: {"cmd": "start", "breakpoints": [linenos]}
          {"cmd": "step" | "next" | "return" | "continue"}
          {"cmd": "quit"}
Events:   {"event": "stopped", "file", "line", "func",
           "vars": {name: repr}, "stdout": "new output"}
          {"event": "exited", "code", "stdout", "error"?}
"""
import bdb
import io
import json
import sys
import traceback


def emit(obj):
    sys.__stdout__.write(json.dumps(obj) + "\n")
    sys.__stdout__.flush()


def read_cmd():
    line = sys.stdin.readline()
    if not line:
        return {"cmd": "quit"}
    try:
        return json.loads(line)
    except Exception:
        return {"cmd": "continue"}


class Bridge(bdb.Bdb):
    def __init__(self, target):
        super().__init__()
        self.target = target
        self.capture = io.StringIO()
        self.sent_upto = 0

    def fresh_stdout(self):
        text = self.capture.getvalue()
        new = text[self.sent_upto:]
        self.sent_upto = len(text)
        return new

    def user_call(self, frame, args):
        # First call event inside the target: botframe exists
        # by now, so arming "continue to first breakpoint" is
        # legal here (calling set_continue before run() is not).
        if getattr(self, "_arm", False) and \
                frame.f_code.co_filename == self.target:
            self._arm = False
            self.set_continue()

    def user_line(self, frame):
        if frame.f_code.co_filename != self.target:
            return
        real_out = sys.stdout
        sys.stdout = sys.__stdout__
        try:
            vars_out = {}
            for k, v in list(frame.f_locals.items())[:40]:
                if k.startswith("__"):
                    continue
                try:
                    r = repr(v)
                except Exception:
                    r = "<unrepresentable>"
                vars_out[k] = r[:120]
            emit({
                "event": "stopped",
                "file": self.target,
                "line": frame.f_lineno,
                "func": frame.f_code.co_name,
                "vars": vars_out,
                "stdout": self.fresh_stdout(),
            })
            while True:
                cmd = read_cmd().get("cmd", "continue")
                if cmd == "step":
                    self.set_step()
                    return
                if cmd == "next":
                    self.set_next(frame)
                    return
                if cmd == "return":
                    self.set_return(frame)
                    return
                if cmd == "continue":
                    self.set_continue()
                    return
                if cmd == "quit":
                    self.set_quit()
                    return
        finally:
            sys.stdout = real_out

    # Note: no user_exception hook - bdb reports every raise,
    # including ones the debuggee handles itself. An uncaught
    # exception propagates out of run() and is reported by
    # main() instead, which is the honest signal.


def main():
    target = sys.argv[1]
    start = read_cmd()
    bridge = Bridge(target)
    for ln in start.get("breakpoints", []):
        try:
            bridge.set_break(target, int(ln))
        except Exception:
            pass
    bridge._arm = True
    code = ("exec(compile(open(%r).read(), %r, 'exec'), "
            "{'__name__': '__main__', '__file__': %r})"
            % (target, target, target))
    real_stdout = sys.stdout
    capture_holder = bridge
    sys.stdout = bridge.capture
    error = None
    try:
        bridge.run(code)
    except bdb.BdbQuit:
        pass
    except Exception:
        error = traceback.format_exc()
    finally:
        sys.stdout = real_stdout
    emit({
        "event": "exited",
        "code": 0 if error is None else 1,
        "stdout": bridge.fresh_stdout(),
        "error": error,
    })


if __name__ == "__main__":
    main()
