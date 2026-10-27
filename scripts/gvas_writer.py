"""Serialise the structure produced by gvas_parser back into a GVAS file.

Usage:
  python gvas_writer.py SaveGame.sav --verify          # parse + rebuild, compare bytes
  python gvas_writer.py edited.json out.sav            # rebuild a save from edited JSON

Property sizes are recomputed, so values may change length (strings, arrays,
map entries...). "offset"/"size" fields in the JSON are ignored.
"""
import json
import re
import struct
import sys
import uuid

import gvas_parser as g
from gvas_parser import NATIVE, TypeName


class Writer:
    def __init__(self):
        self.b = bytearray()

    def raw(self, data): self.b += data
    def pack(self, fmt, v): self.b += struct.pack("<" + fmt, v)
    def u8(self, v): self.pack("B", v)
    def i32(self, v): self.pack("i", v)
    def guid(self, s): self.b += uuid.UUID(s).bytes_le

    def fstring(self, s):
        if s == "":
            return self.i32(0)
        if s.isascii():
            data = s.encode() + b"\0"
            self.i32(len(data))
        else:
            data = (s + "\0").encode("utf-16-le")
            self.i32(-len(data) // 2)
        self.b += data


def parse_type(text):
    """Inverse of TypeName.__repr__ (name or name<child, child>)."""
    def parse(i):
        j = i
        while j < len(text) and text[j] not in "<,>":
            j += 1
        t = TypeName.__new__(TypeName)
        t.name, t.params = text[i:j], []
        if j < len(text) and text[j] == "<":
            j += 1
            while True:
                child, j = parse(j)
                t.params.append(child)
                if text[j] == ",":
                    j += 2  # ", "
                    continue
                j += 1  # ">"
                break
        return t, j
    return parse(0)[0]


def write_type(w, t):
    w.fstring(t.name)
    w.i32(len(t.params))
    for c in t.params:
        write_type(w, c)


def write_soft_path(w, v):
    w.fstring(v["package"])
    w.fstring(v["asset"])
    if v.get("subpath_no_nul"):
        data = v["subpath"].encode()
        w.i32(len(data))
        w.raw(data)
    else:
        w.fstring(v["subpath"])


def write_native_struct(w, name, v):
    """Mirror of gvas_parser.read_native_struct; returns False if unsupported."""
    if name in ("Vector", "Rotator", "Vector3d", "Vector3f", "Rotator3f"):
        f = "f" if name in ("Vector3f", "Rotator3f") else "d"
        for c in "xyz":
            w.pack(f, v[c])
    elif name in ("Vector2D", "Vector2d"):
        w.pack("d", v["x"]); w.pack("d", v["y"])
    elif name in ("Quat", "Vector4"):
        for c in "xyzw":
            w.pack("d", v[c])
    elif name == "LinearColor":
        for c in "rgba":
            w.pack("f", v[c])
    elif name == "Color":
        for c in "bgra":
            w.u8(v[c])
    elif name == "GameplayTag":
        w.fstring(v)
    elif name == "GameplayTagContainer":
        w.i32(len(v))
        for s in v:
            w.fstring(s)
    elif name == "Guid":
        w.guid(v)
    elif name in ("DateTime", "Timespan"):
        w.pack("q", v)
    elif name == "IntPoint":
        w.i32(v[0]); w.i32(v[1])
    elif name in ("SoftObjectPath", "SoftClassPath", "TopLevelAssetPath"):
        write_soft_path(w, v)
    else:
        return False
    return True


NATIVE_WRITABLE = NATIVE | {"GameplayTag"}
SIMPLE = {"IntProperty": "i", "UInt32Property": "I", "Int64Property": "q",
          "UInt64Property": "Q", "Int16Property": "h", "UInt16Property": "H",
          "Int8Property": "b", "FloatProperty": "f", "DoubleProperty": "d"}
STRINGY = ("StrProperty", "NameProperty", "EnumProperty", "ObjectProperty")


class GvasWriter:
    def __init__(self):
        self.w = Writer()

    def write(self, doc):
        w, h = self.w, doc["header"]
        w.raw(b"GVAS")
        w.i32(h["save_game_version"])
        w.i32(h["package_version_ue4"])
        if h["save_game_version"] >= 3:
            w.i32(h["package_version_ue5"])
        e = h["engine_version"]
        w.pack("H", e["major"]); w.pack("H", e["minor"]); w.pack("H", e["patch"])
        w.pack("I", e["changelist"]); w.fstring(e["branch"])
        w.i32(h["custom_version_format"])
        w.i32(len(h["custom_versions"]))
        for cv in h["custom_versions"]:
            w.guid(cv["guid"]); w.i32(cv["version"])
        w.fstring(h["save_game_class"])
        w.u8(h["post_class_byte"])
        self.properties(doc["properties"])
        w.raw(bytes.fromhex(doc["trailing"]))
        return bytes(w.b)

    def properties(self, props):
        w = self.w
        for key, ent in props.items():
            flags = ent.get("flags", 0)
            m = re.fullmatch(r"(.*)\[(\d+)\]", key) if flags & 1 else None
            name, idx = (m.group(1), int(m.group(2))) if m else (key, 0)
            t = parse_type(ent["type"])
            val = ent["value"]
            if t.name == "BoolProperty":
                flags = (flags & ~0x10) | (0x10 if val else 0)
            outer = self.w
            self.w = Writer()
            try:
                if isinstance(val, dict) and "_raw" in val:
                    self.w.raw(bytes.fromhex(val["_raw"]))
                elif t.name != "BoolProperty":
                    self.value(t, val, flags)
                body = bytes(self.w.b)
            finally:
                self.w = outer
            w.fstring(name)
            write_type(w, t)
            w.i32(len(body))
            w.u8(flags)
            if flags & 1: w.i32(idx)
            if flags & 2: w.guid(ent["guid"])
            w.raw(body)
        w.fstring("None")

    def value(self, t, v, flags=0):
        if t.name == "StructProperty":
            return self.struct(t, v, flags)
        return self.inner(t, v)

    def inner(self, t, v):
        w, n = self.w, t.name
        if n in SIMPLE:
            w.pack(SIMPLE[n], v)
        elif n in STRINGY:
            w.fstring(v)
        elif n == "BoolProperty":
            w.u8(1 if v else 0)
        elif n == "ByteProperty":
            w.fstring(v) if isinstance(v, str) else w.u8(v)
        elif n == "SoftObjectProperty":
            write_soft_path(w, v)
        elif n == "TextProperty":
            self.text(v)
        elif n in ("ArrayProperty", "SetProperty"):
            self.array(t, v)
        elif n == "MapProperty":
            self.map(t, v)
        elif n == "StructProperty":
            self.struct(t, v, 0)
        else:
            raise NotImplementedError(n)

    def struct(self, t, v, flags):
        sname = t.params[0].name if t.params else ""
        if sname == "AnyValue":
            return self.any_value(v)
        inner = v["value"]
        if isinstance(inner, dict) and "_raw" in inner:
            return self.w.raw(bytes.fromhex(inner["_raw"]))
        if (flags & 0x08 or sname in NATIVE) and sname in NATIVE_WRITABLE:
            if write_native_struct(self.w, sname, inner):
                return
        self.properties(inner)

    def any_value(self, v):
        w = self.w
        if "type" not in v:
            return w.u8(0)
        w.u8(1)
        w.fstring(v["type"])
        short = v["type"].rsplit(".", 1)[-1]
        inner = v["value"]
        if v["type"].endswith(".InstancedPropertyBag"):
            return self.property_bag(inner)
        if short in NATIVE and write_native_struct(w, short, inner):
            return
        self.properties(inner)

    def property_bag(self, bag):
        w = self.w
        if bag is None:
            return w.i32(0)
        w.i32(1)
        w.i32(len(bag["descriptors"]))
        for d in bag["descriptors"]:
            w.fstring(d["object"]); w.guid(d["id"]); w.fstring(d["name"])
            w.u8(d["value_type"])
            w.u8(len(d["container_types"]))
            for c in d["container_types"]:
                w.u8(c)
            w.i32(d["metadata_count"])
        outer = self.w
        self.w = Writer()
        try:
            self.properties(bag["values"])
            body = bytes(self.w.b)
        finally:
            self.w = outer
        w.i32(len(body))
        w.raw(body)

    def text(self, v):
        w = self.w
        w.pack("I", v["flags"])
        if "invariant" in v:
            w.pack("b", -1)
            w.pack("I", 0 if v["invariant"] is None else 1)
            if v["invariant"] is not None:
                w.fstring(v["invariant"])
        else:
            w.pack("b", 0)
            for k in ("namespace", "key", "source"):
                w.fstring(v[k])

    def element(self, inner, v):
        if inner.name == "StructProperty":
            sname = inner.params[0].name if inner.params else ""
            if sname == "AnyValue":
                return self.any_value(v)
            if sname in NATIVE and write_native_struct(self.w, sname, v["value"]):
                return
            return self.properties(v["value"])
        self.inner(inner, v)

    def array(self, t, v):
        inner = t.params[0]
        if isinstance(v, dict) and "bytes" in v:
            data = bytes.fromhex(v["bytes"])
            self.w.i32(len(data))
            return self.w.raw(data)
        self.w.i32(len(v))
        for item in v:
            self.element(inner, item)

    def map(self, t, items):
        kt, vt = t.params
        self.w.i32(0)
        self.w.i32(len(items))
        for it in items:
            self.element(kt, it["key"])
            self.element(vt, it["value"])


def build(doc):
    return GvasWriter().write(doc)


if __name__ == "__main__":
    src, arg = sys.argv[1], sys.argv[2]
    if arg == "--verify":
        original = open(src, "rb").read()
        doc = json.loads(json.dumps(g.parse_file(src)))  # via JSON, as an edit would
        rebuilt = build(doc)
        if rebuilt == original:
            print(f"OK: rebuilt {len(rebuilt)} bytes identical to original")
        else:
            at = next((i for i, (a, b) in enumerate(zip(rebuilt, original)) if a != b),
                      min(len(rebuilt), len(original)))
            sys.exit(f"MISMATCH at byte {at} (rebuilt {len(rebuilt)}, original {len(original)})")
    else:
        with open(src) as f:
            data = build(json.load(f))
        with open(arg, "wb") as f:
            f.write(data)
        print(f"wrote {arg} ({len(data)} bytes)")
