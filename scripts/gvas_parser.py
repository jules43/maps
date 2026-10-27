"""Parser for Unreal Engine 5.x GVAS save files (SaveGame.sav), incl. UE 5.7.

Usage: python gvas_parser.py SaveGame.sav [out.json]

Handles the UE5.5+ "complete type name" property tags. Property values that
cannot be decoded are kept as {"_raw": hex} so that the rest of the file still
parses and re-serialising is never silently lossy.
"""
import json
import struct
import sys
import uuid


class Reader:
    def __init__(self, data, pos=0):
        self.d = data
        self.p = pos

    def read(self, n):
        if self.p + n > len(self.d):
            raise EOFError(f"read {n} bytes at {self.p} past end {len(self.d)}")
        b = self.d[self.p:self.p + n]
        self.p += n
        return b

    def unpack(self, fmt):
        s = struct.calcsize(fmt)
        v = struct.unpack_from("<" + fmt, self.d, self.p)
        if self.p + s > len(self.d):
            raise EOFError
        self.p += s
        return v[0] if len(v) == 1 else v

    def u8(self): return self.unpack("B")
    def i8(self): return self.unpack("b")
    def i16(self): return self.unpack("h")
    def u16(self): return self.unpack("H")
    def i32(self): return self.unpack("i")
    def u32(self): return self.unpack("I")
    def i64(self): return self.unpack("q")
    def u64(self): return self.unpack("Q")
    def f32(self): return self.unpack("f")
    def f64(self): return self.unpack("d")

    def guid(self):
        return str(uuid.UUID(bytes_le=self.read(16)))

    def fstring(self):
        n = self.i32()
        if n == 0:
            return ""
        if n < 0:
            raw = self.read(-n * 2)
            return raw[:-2].decode("utf-16-le")
        raw = self.read(n)
        return raw[:-1].decode("utf-8", errors="replace")


class TypeName:
    """FPropertyTypeName tree: name + inner type parameters."""

    def __init__(self, r):
        self.name = r.fstring()
        n = r.i32()
        self.params = [TypeName(r) for _ in range(n)]

    def __repr__(self):
        if not self.params:
            return self.name
        return f"{self.name}<{', '.join(map(repr, self.params))}>"


def raw(r, n):
    return {"_raw": r.read(n).hex()}


# Structs serialised natively (not as a property list). UE5 uses doubles (LWC).
def read_native_struct(r, name, size):
    if name in ("Vector", "Rotator", "Vector3d", "Vector3f", "Rotator3f"):
        if size == 24 or name in ("Vector", "Rotator", "Vector3d"):
            return dict(zip("xyz", (r.f64(), r.f64(), r.f64())))
        return dict(zip("xyz", (r.f32(), r.f32(), r.f32())))
    if name in ("Vector2D", "Vector2d"):
        return dict(zip("xy", (r.f64(), r.f64())))
    if name in ("Quat",):
        return dict(zip("xyzw", (r.f64(), r.f64(), r.f64(), r.f64())))
    if name == "Vector4":
        return dict(zip("xyzw", (r.f64(), r.f64(), r.f64(), r.f64())))
    if name == "LinearColor":
        return dict(zip("rgba", (r.f32(), r.f32(), r.f32(), r.f32())))
    if name == "Color":
        return dict(zip("bgra", (r.u8(), r.u8(), r.u8(), r.u8())))
    if name == "GameplayTag":
        return r.fstring()
    if name == "GameplayTagContainer":
        return [r.fstring() for _ in range(r.i32())]
    if name == "Guid":
        return r.guid()
    if name in ("DateTime", "Timespan"):
        return r.i64()
    if name == "IntPoint":
        return [r.i32(), r.i32()]
    if name in ("GameplayTagContainer", "SoftObjectPath", "SoftClassPath", "TopLevelAssetPath"):
        return read_soft_path(r)
    return None


def read_soft_path(r):
    d = {"package": r.fstring(), "asset": r.fstring()}
    # The game writes some sub-paths without a trailing NUL; keep every character.
    n = r.i32()
    if n > 0 and r.d[r.p + n - 1] != 0:
        d["subpath"] = r.read(n).decode("utf-8", errors="replace")
        d["subpath_no_nul"] = True
    else:
        r.p -= 4
        d["subpath"] = r.fstring()
    return d


class Parser:
    def __init__(self, data):
        self.r = Reader(data)

    # ---- header ----
    def parse(self):
        r = self.r
        if r.read(4) != b"GVAS":
            raise ValueError("not a GVAS file")
        h = {"save_game_version": r.i32()}
        h["package_version_ue4"] = r.i32()
        if h["save_game_version"] >= 3:
            h["package_version_ue5"] = r.i32()
        h["engine_version"] = {
            "major": r.u16(), "minor": r.u16(), "patch": r.u16(),
            "changelist": r.u32(), "branch": r.fstring(),
        }
        fmt = r.i32()
        h["custom_version_format"] = fmt
        h["custom_versions"] = [
            {"guid": r.guid(), "version": r.i32()} for _ in range(r.i32())
        ]
        h["save_game_class"] = r.fstring()
        # UE5.5+ writes one byte (0 in all observed saves) before the properties.
        h["post_class_byte"] = r.u8()
        props = self.read_properties()
        trailing = r.d[r.p:]
        return {"header": h, "properties": props,
                "trailing": trailing.hex() if trailing else ""}

    # ---- properties ----
    def read_properties(self):
        """Property list terminated by 'None'. Duplicate names become lists."""
        out = {}
        r = self.r
        while True:
            name = r.fstring()
            if name == "None":
                return out
            ptype = TypeName(r)
            size = r.i32()
            flags = r.u8()
            idx = r.i32() if flags & 0x01 else 0
            guid = r.guid() if flags & 0x02 else None
            if flags & 0x04:
                raise NotImplementedError("property extensions")
            start = r.p
            try:
                val = self.read_value(ptype, size, flags)
                if r.p != start + size:
                    raise ValueError(f"consumed {r.p - start} of {size}")
            except Exception as e:  # keep going with raw bytes
                r.p = start
                val = {"_raw": r.read(size).hex(), "_error": str(e)}
            entry = {"type": repr(ptype), "value": val, "flags": flags, "offset": start, "size": size}
            if guid:
                entry["guid"] = guid
            key = name if idx == 0 else f"{name}[{idx}]"
            out[key] = entry

    def read_value(self, t, size, flags=0):
        r = self.r
        n = t.name
        if n == "BoolProperty":
            return bool(flags & 0x10)
        if n == "StructProperty":
            return self.read_struct(t, size, flags)
        return self.read_inner(t, size)

    def read_inner(self, t, size=None):
        """Value body of a non-struct, non-bool property (or container element)."""
        r = self.r
        n = t.name
        simple = {
            "IntProperty": r.i32, "UInt32Property": r.u32,
            "Int64Property": r.i64, "UInt64Property": r.u64,
            "Int16Property": r.i16, "UInt16Property": r.u16,
            "Int8Property": r.i8, "FloatProperty": r.f32,
            "DoubleProperty": r.f64, "StrProperty": r.fstring,
            "NameProperty": r.fstring, "EnumProperty": r.fstring,
        }
        if n in simple:
            return simple[n]()
        if n == "BoolProperty":
            return bool(r.u8())
        if n == "ByteProperty":
            # Enum-typed bytes are stored as names, plain ones as one byte.
            if t.params and t.params[0].name != "None" and size != 1:
                return r.fstring()
            return r.u8()
        if n == "ObjectProperty":
            return r.fstring()
        if n == "SoftObjectProperty":
            return read_soft_path(r)
        if n == "TextProperty":
            return self.read_text()
        if n == "ArrayProperty" or n == "SetProperty":
            return self.read_array(t, size)
        if n == "MapProperty":
            return self.read_map(t)
        if n == "StructProperty":
            return self.read_struct(t, size, 0)
        raise NotImplementedError(n)

    def read_any_value(self):
        """/Script/AnyValue custom struct: valid byte, struct path, properties."""
        r = self.r
        if not r.u8():
            return {"struct": "AnyValue", "value": None}
        stype = r.fstring()
        if stype.endswith(".InstancedPropertyBag"):
            return {"struct": "AnyValue", "type": stype,
                    "value": self.read_property_bag()}
        short = stype.rsplit(".", 1)[-1]
        native = read_native_struct(r, short, 0) if short in NATIVE else None
        if native is not None:
            return {"struct": "AnyValue", "type": stype, "value": native}
        return {"struct": "AnyValue", "type": stype, "value": self.read_properties()}

    def read_property_bag(self):
        """FInstancedPropertyBag: descriptors followed by size-prefixed tagged data."""
        r = self.r
        if not r.i32():
            return None
        descs = []
        for _ in range(r.i32()):
            d = {"object": r.fstring(), "id": r.guid(), "name": r.fstring(),
                 "value_type": r.u8()}
            d["container_types"] = [r.u8() for _ in range(r.u8())]
            d["metadata_count"] = r.i32()
            if d["metadata_count"]:
                raise NotImplementedError("property bag metadata")
            descs.append(d)
        end = r.i32() + r.p
        values = self.read_properties()
        if r.p != end:
            raise ValueError("property bag size mismatch")
        return {"descriptors": descs, "values": values}

    def read_struct(self, t, size, flags):
        r = self.r
        sname = t.params[0].name if t.params else ""
        if sname == "AnyValue":
            return self.read_any_value()
        if flags & 0x08 or sname in NATIVE:
            v = read_native_struct(r, sname, size)
            if v is not None:
                return {"struct": sname, "value": v}
            if flags & 0x08:
                return {"struct": sname, "value": raw(r, size)}
        return {"struct": sname, "value": self.read_properties()}

    def read_text(self):
        r = self.r
        flags = r.u32()
        htype = r.i8()
        if htype == -1:
            has = r.u32()
            return {"flags": flags, "invariant": r.fstring() if has else None}
        if htype == 0:
            return {"flags": flags, "namespace": r.fstring(),
                    "key": r.fstring(), "source": r.fstring()}
        raise NotImplementedError(f"text history {htype}")

    def read_array(self, t, size):
        r = self.r
        count = r.i32()
        inner = t.params[0]
        if inner.name == "ByteProperty" and not inner.params:
            return {"bytes": r.read(count).hex()}
        return [self.read_element(inner, size) for _ in range(count)]

    def read_element(self, inner, size=None):
        if inner.name == "StructProperty":
            sname = inner.params[0].name if inner.params else ""
            if sname == "AnyValue":
                return self.read_any_value()
            if sname in NATIVE:
                v = read_native_struct(self.r, sname, 0)
                if v is not None:
                    return {"struct": sname, "value": v}
            return {"struct": sname, "value": self.read_properties()}
        return self.read_inner(inner)

    def read_map(self, t):
        r = self.r
        kt, vt = t.params
        removed = r.i32()
        if removed:
            raise NotImplementedError("map with removed keys")
        count = r.i32()
        items = []
        for _ in range(count):
            items.append({"key": self.read_element(kt), "value": self.read_element(vt)})
        return items


NATIVE = {"Vector", "Rotator", "Vector3d", "Vector3f", "Rotator3f", "Vector2D",
          "Vector2d", "Quat", "Vector4", "LinearColor", "Color", "Guid",
          "DateTime", "Timespan", "IntPoint", "GameplayTagContainer", "SoftObjectPath", "SoftClassPath", "TopLevelAssetPath"}


def parse_file(path):
    with open(path, "rb") as f:
        return Parser(f.read()).parse()


def count_raw(o):
    if isinstance(o, dict):
        if "_raw" in o:
            return 1
        return sum(count_raw(v) for v in o.values())
    if isinstance(o, list):
        return sum(count_raw(v) for v in o)
    return 0


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "SaveGame.sav"
    result = parse_file(src)
    text = json.dumps(result, indent=2)
    if len(sys.argv) > 2:
        with open(sys.argv[2], "w") as f:
            f.write(text)
        print(f"wrote {sys.argv[2]}; undecoded properties: {count_raw(result)}")
    else:
        print(text)
