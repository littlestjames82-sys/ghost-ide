#!/usr/bin/env python3
"""Roadmap G28: build refdocs.json, the IDE's bundled offline
reference.

Python entries are extracted from the local interpreter's own
documentation (pydoc data: __doc__ strings + inspect
signatures), so what ships is the real reference text for the
stdlib slice the IDE bundles. JavaScript entries are short
hand-written summaries of the core language surface.

Run:  python3 tools/gen_refdocs.py
Out:  refdocs.json next to server.py (desktop) - build.sh
      copies it into the APK assets for the phone.
"""
import builtins
import importlib
import inspect
import json
import pathlib
import re

PY_MODULES = [
    "os", "os.path", "sys", "json", "re", "math", "random",
    "datetime", "pathlib", "collections", "itertools",
    "functools", "string", "textwrap", "time", "subprocess",
    "threading", "shutil", "glob", "io", "base64", "hashlib",
    "urllib.parse", "statistics", "operator",
]
BUILTINS = [
    "len", "print", "open", "range", "enumerate", "zip",
    "map", "filter", "sorted", "reversed", "isinstance",
    "type", "str", "int", "float", "list", "dict", "set",
    "tuple", "bool", "sum", "min", "max", "abs", "round",
    "any", "all", "input", "format", "repr", "help",
]
BODY_CAP = 3200
SUMMARY_CAP = 240
PER_MODULE_CAP = 140


def clean(doc):
    if not doc:
        return ""
    return inspect.cleandoc(doc).strip()


def summarize(doc):
    text = clean(doc)
    if not text:
        return ""
    para = re.split(r"\n\s*\n", text)[0]
    para = " ".join(para.split())
    return para[:SUMMARY_CAP]


def signature(obj, qualname):
    try:
        sig = str(inspect.signature(obj))
    except (TypeError, ValueError):
        return qualname
    return qualname + sig


def entry(lang, title, doc, sig=None):
    body = clean(doc)
    if sig:
        body = sig + "\n\n" + body
    body = body[:BODY_CAP]
    terms = sorted(set(re.findall(r"[a-z0-9]+",
                                  title.lower())))
    return {"id": lang + ":" + title, "lang": lang,
            "title": title, "summary": summarize(doc),
            "body": body, "terms": terms}


def py_entries():
    out = []
    for modname in PY_MODULES:
        try:
            mod = importlib.import_module(modname)
        except Exception:
            continue
        if getattr(mod, "__doc__", None):
            out.append(entry("py", modname, mod.__doc__))
        count = 0
        for name in sorted(dir(mod)):
            if name.startswith("_") or count >= PER_MODULE_CAP:
                continue
            try:
                obj = getattr(mod, name)
            except Exception:
                continue
            if inspect.ismodule(obj):
                continue
            # Callables and classes only: module constants
            # (os.CLONE_* and friends) carry their TYPE's doc
            # string, which made junk entries that ate the cap
            # before the real functions were reached.
            if not (inspect.isfunction(obj) or
                    inspect.isbuiltin(obj) or
                    inspect.isclass(obj) or
                    inspect.ismethod(obj)):
                continue
            doc = getattr(obj, "__doc__", None)
            if not doc:
                continue
            # No owner-module filter: the stdlib's own alias
            # layers defeat it (os.getcwd lives in posix,
            # os.path.exists in genericpath, os.path.join in
            # posixpath). The title carries this module's
            # prefix by construction, so entries cannot
            # collide; the doc text is the member's own.
            qual = modname + "." + name
            sig = None
            if inspect.isfunction(obj) or inspect.isbuiltin(obj) \
                    or inspect.isclass(obj):
                sig = signature(obj, qual)
            out.append(entry("py", qual, doc, sig))
            count += 1
    for name in BUILTINS:
        obj = getattr(builtins, name, None)
        if obj is None or not getattr(obj, "__doc__", None):
            continue
        out.append(entry("py", name, obj.__doc__,
                         signature(obj, name)))
    return out


JS = [
    ("Array.prototype.map",
     "Creates a new array with the results of calling fn on every element.",
     "arr.map(fn(value, index, array)) -> new array\n\nfn runs once per element; the original array is unchanged. Use it to transform data: [1,2,3].map(x => x * 2) is [2,4,6]. For side effects only, prefer forEach."),
    ("Array.prototype.filter",
     "Creates a new array with only the elements fn returns truthy for.",
     "arr.filter(fn(value, index, array)) -> new array\n\n[1,2,3,4].filter(x => x % 2 === 0) is [2,4]. The original array is unchanged."),
    ("Array.prototype.reduce",
     "Folds an array into a single value by running fn(accumulator, value) over it.",
     "arr.reduce(fn(acc, value, index), initial) -> value\n\n[1,2,3].reduce((a, x) => a + x, 0) is 6. Always pass an initial value on possibly-empty arrays, or reduce throws on an empty array."),
    ("Array.prototype.forEach",
     "Runs fn once per element, for side effects. Returns undefined.",
     "arr.forEach(fn(value, index, array))\n\nYou cannot break out early; use a for..of loop or some/every when you need to stop."),
    ("Array.prototype.find",
     "Returns the first element fn returns truthy for, or undefined.",
     "arr.find(fn(value)) -> element | undefined\narr.findIndex(fn) returns the index instead, or -1."),
    ("Array.prototype.includes",
     "Tests whether the array contains a value (SameValueZero comparison).",
     "arr.includes(value) -> boolean\narr.indexOf(value) returns the index or -1. includes is the clearer boolean check and finds NaN, which indexOf does not."),
    ("Array.prototype.slice",
     "Returns a shallow copy of a portion of the array, without modifying it.",
     "arr.slice(begin, end) -> new array\n\nNegative indexes count from the end. arr.slice() copies the whole array. Contrast splice, which mutates."),
    ("Array.prototype.splice",
     "Adds or removes elements in place; returns the removed elements.",
     "arr.splice(start, deleteCount, ...items) -> removed array\n\nMutates the original. splice(1, 1) removes one element at index 1."),
    ("Array.prototype.push",
     "Appends elements to the end; returns the new length.",
     "arr.push(...items) -> new length\narr.pop() removes and returns the last element; arr.shift() the first; arr.unshift(...items) prepends."),
    ("Array.prototype.join",
     "Joins elements into a string with a separator (default comma).",
     "arr.join(sep) -> string\n\n['a','b'].join('-') is 'a-b'. The inverse is String.prototype.split."),
    ("Array.prototype.sort",
     "Sorts in place. Without a comparator it sorts as strings, which surprises with numbers.",
     "arr.sort(cmpFn) -> the same array, sorted\n\n[10, 9].sort() gives [10, 9] (string order). For numbers: arr.sort((a, b) => a - b)."),
    ("Array.prototype.some",
     "True when fn returns truthy for at least one element; stops early.",
     "arr.some(fn(value)) -> boolean\narr.every(fn) is the all-elements version and also stops early."),
    ("Array.prototype.flat",
     "Flattens nested arrays up to depth (default 1); Infinity flattens fully.",
     "arr.flat(depth) -> new array\n\n[1, [2, [3]]].flat() is [1, 2, [3]]; .flat(Infinity) is [1, 2, 3]. flatMap(fn) maps then flattens one level."),
    ("String.prototype.split",
     "Splits a string into an array by a separator.",
     "str.split(sep, limit) -> array\n\n'a,b'.split(',') is ['a','b']. str.split('') splits into characters. Inverse: Array.prototype.join."),
    ("String.prototype.replace",
     "Replaces the first match (or all with a /g regex or replaceAll) of a pattern.",
     "str.replace(pattern, replacement) -> new string\n\nReplacements can use $1 capture groups or a function. Strings are immutable; replace returns a new string."),
    ("String.prototype.trim",
     "Removes whitespace from both ends of the string.",
     "str.trim() -> new string\ntrimStart / trimEnd remove one side only."),
    ("String.prototype.includes",
     "Tests whether the string contains a substring.",
     "str.includes(sub, position) -> boolean\nAlso: str.startsWith(sub), str.endsWith(sub), str.indexOf(sub)."),
    ("String.prototype.padStart",
     "Pads the string on the left until it reaches the given length.",
     "str.padStart(len, padStr) -> string\n\n'7'.padStart(2, '0') is '07'. padEnd pads on the right."),
    ("Object.keys",
     "Returns an array of an object's own enumerable property names.",
     "Object.keys(obj) -> array of strings\nObject.values(obj) returns the values, Object.entries(obj) returns [key, value] pairs. Object.assign(target, ...sources) copies properties."),
    ("Object.entries",
     "Returns [key, value] pairs for an object's own enumerable properties.",
     "Object.entries(obj) -> array\n\nCommon pattern: for (const [k, v] of Object.entries(obj)) { ... }"),
    ("JSON.parse",
     "Parses a JSON string into a JavaScript value. Throws SyntaxError on invalid JSON.",
     "JSON.parse(text) -> value\n\nWrap in try/catch when the text is not fully trusted. JSON keys must be double-quoted strings."),
    ("JSON.stringify",
     "Turns a JavaScript value into a JSON string.",
     "JSON.stringify(value, replacer, space) -> string\n\nJSON.stringify(obj, null, 2) pretty-prints. undefined, functions and symbols are dropped from objects."),
    ("Promise",
     "Represents a value that will be available later. States: pending, fulfilled, rejected.",
     "new Promise((resolve, reject) => { ... })\n\nConsumed with .then(onOk, onErr), .catch(onErr), .finally(fn), or await inside an async function. Promise.all(promises) waits for all; Promise.race takes the first settled."),
    ("async function",
     "A function that returns a Promise; await pauses it until a Promise settles.",
     "async function f() { const v = await g(); return v; }\n\nawait only works inside async functions (and top-level module code). A rejected await throws, so try/catch handles async errors."),
    ("fetch",
     "Browser/Node HTTP client returning a Promise of a Response.",
     "const res = await fetch(url, { method, headers, body });\nconst data = await res.json();\n\nfetch does NOT reject on HTTP error statuses; check res.ok. It rejects only on network failure."),
    ("Map",
     "Key-value collection with any value as key, keeping insertion order.",
     "const m = new Map(); m.set(k, v); m.get(k); m.has(k); m.delete(k); m.size\n\nIterate with for (const [k, v] of m). Unlike objects, keys are not forced to strings."),
    ("Set",
     "A collection of unique values.",
     "const s = new Set([1, 2]); s.add(v); s.has(v); s.delete(v); s.size\n\nCommon use: deduplicate an array with [...new Set(arr)]."),
    ("Math.round",
     "Rounds to the nearest integer (halves round toward +Infinity).",
     "Math.round(x)\nMath.floor(x) rounds down, Math.ceil(x) up, Math.trunc(x) toward zero."),
    ("Math.random",
     "Returns a pseudo-random number in [0, 1). Not cryptographically secure.",
     "Math.random() -> number\nRandom integer in [min, max]: Math.floor(Math.random() * (max - min + 1)) + min. For security use crypto.getRandomValues."),
    ("Math.max",
     "Returns the largest of the given numbers; -Infinity for none.",
     "Math.max(...nums)\nMath.min is the smallest. Spread an array: Math.max(...arr)."),
    ("console.log",
     "Prints values to the console for debugging.",
     "console.log(...values)\nAlso console.warn, console.error (same shape), console.table(data) for arrays/objects, console.time(label)/timeEnd(label) for timing."),
    ("typeof",
     "Returns a string naming the type of a value.",
     "typeof x -> 'number' | 'string' | 'boolean' | 'undefined' | 'object' | 'function' | 'symbol' | 'bigint'\n\ntypeof null is 'object' (a famous historical bug). Arrays are 'object'; use Array.isArray(x) for arrays."),
    ("Array.isArray",
     "True when the value is an array.",
     "Array.isArray(x) -> boolean\nUse this instead of typeof or instanceof for array checks; it works across realms."),
    ("parseInt",
     "Parses a string as an integer in the given radix (base). Always pass the radix.",
     "parseInt(str, 10) -> integer or NaN\nparseFloat(str) parses decimals. Number(str) converts strictly and is usually preferable: Number('12px') is NaN while parseInt gives 12."),
    ("addEventListener",
     "Registers a handler for an event on an element or document.",
     "el.addEventListener('click', handler, { once: true })\n\nThe handler receives an event object; call event.preventDefault() to stop the default action. removeEventListener needs the same function reference."),
    ("querySelector",
     "Finds the first element matching a CSS selector; querySelectorAll finds all.",
     "document.querySelector('.item') -> element | null\ndocument.getElementById('id') is the id-only shortcut."),
    ("localStorage",
     "Synchronous key-value storage that persists per origin; strings only.",
     "localStorage.setItem(k, v); localStorage.getItem(k); localStorage.removeItem(k)\nStore objects via JSON.stringify / JSON.parse. About 5 MB per origin."),
    ("Date",
     "Represents a moment in time as milliseconds since the Unix epoch (UTC).",
     "new Date() is now; new Date(isoString) parses; date.toISOString() formats UTC.\nMonths are 0-based (0 = January). getTime() gives epoch milliseconds."),
    ("RegExp",
     "Regular expressions: literal /pattern/flags or new RegExp(string).",
     "const re = /\\d+/g; re.test(str) -> boolean; str.match(re) -> matches\nFlags: g global, i case-insensitive, m multiline, s dotAll. Beware: a /g regex's lastIndex makes repeated .test calls stateful."),
    ("Error",
     "Throw and catch errors with throw new Error(message) and try/catch.",
     "try { throw new Error('nope'); } catch (e) { console.error(e.message); } finally { ... }\nCustom errors: class MyError extends Error {}"),
    ("Spread syntax",
     "Expands an iterable or object into elements/properties: [...arr], {...obj}, fn(...args).",
     "const copy = [...arr]; const merged = { ...a, ...b };\nRest parameters collect the opposite way: function f(...args) {}."),
    ("Destructuring",
     "Unpacks array elements or object properties into variables in one statement.",
     "const [a, b] = arr; const { name, age = 0 } = obj;\nDefaults apply when the value is undefined. Rename: const { name: n } = obj."),
    ("Template literals",
     "Backtick strings with ${expression} interpolation and multiline text.",
     "`Hello ${name}, ${a + b} total`\nTagged templates: tag`...` calls tag with the string parts and values."),
    ("class",
     "Declares a class with a constructor and methods; extends sets up inheritance.",
     "class Dog extends Animal {\n  constructor(name) { super(); this.name = name; }\n  speak() { return this.name + ' barks'; }\n}\nMethods live on the prototype; static methods live on the class itself."),
]


def js_entries():
    return [entry("js", title, summary + "\n\n" + body)
            for title, summary, body in JS]


def main():
    entries = py_entries() + js_entries()
    entries.sort(key=lambda e: (e["lang"], e["title"]))
    out = {"generatedBy": "tools/gen_refdocs.py",
           "entries": entries}
    dest = pathlib.Path(__file__).resolve().parent.parent \
        / "refdocs.json"
    dest.write_text(json.dumps(out))
    by_lang = {}
    for e in entries:
        by_lang[e["lang"]] = by_lang.get(e["lang"], 0) + 1
    print(f"wrote {dest}: {len(entries)} entries "
          f"({by_lang}), {dest.stat().st_size} bytes")


if __name__ == "__main__":
    main()
