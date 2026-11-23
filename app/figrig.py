"""Rig a textured 3D model of a person with the skeleton SAM 3D Body fitted to the same person (Make 3D figure).

The figure is made from an A-pose picture of the person (arms away from the body, legs apart), so the textured mesh
(TRELLIS.2) has a surface of its own under each arm and between the legs. SAM 3D Body fits its skinned body (MHR: 127
bones, linear blend skinning) to that same picture, in the same pose, so the two meet: the mesh is lined up with the
body (its facing, then ICP with a little scale) and every vertex takes the skin weights of the nearest body vertices.

Everything is put in the rig's own frame: facing +Z, the person's left +X, y up, feet at 0, metres (the frame of the
page's Person mannequin). The page poses the figure itself (static/scene3d.js): it only needs each bone's place in
this A-pose, its parent, and which bones are the waist, the neck and each arm's and leg's joints (BONES).

A second fit, of the person's own picture, gives the pose they stand in there, as a mannequin pose (arms and legs as
directions, the spine as angles): the Person starts in it.

numpy only: GLB in and out, nearest neighbours by chunked brute force (a figure is ~30k vertices, a body 18k).
"""
from __future__ import annotations

import json
import math
import struct
from pathlib import Path
from typing import Any

import numpy as np

_CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

# MHR's bones (SAM 3D Body's export names them bone_000...): the ones the page moves. Its template faces +Z with the
# left side at +X, so 2-4 is the left leg and 39-41 the right arm.
BONES = {"pelvis": 1, "waist": 34, "chest": 35, "neck": 110, "head": 113,
         "arm_R": [39, 40, 41], "arm_L": [75, 76, 77], "leg_R": [18, 19, 20], "leg_L": [2, 3, 4]}


# --------------------------------------------------------------------------- GLB


def read_glb(path: Path) -> tuple[dict[str, Any], bytes]:
    b = Path(path).read_bytes()
    if b[:4] != b"glTF":
        raise ValueError(f"{Path(path).name} isn't a GLB file")
    off, js, bin_ = 12, None, b""
    while off < len(b):
        n, t = struct.unpack_from("<II", b, off)
        chunk = b[off + 8: off + 8 + n]
        if t == 0x4E4F534A:
            js = json.loads(chunk)
        elif t == 0x004E4942:
            bin_ = chunk
        off += 8 + n
    if js is None:
        raise ValueError(f"{Path(path).name} has no scene")
    return js, bin_


def accessor(js: dict[str, Any], bin_: bytes, i: int) -> np.ndarray:
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    dt = np.dtype(_CT[a["componentType"]])
    nc = _NC[a["type"]]
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or dt.itemsize * nc
    count = a["count"]
    raw = np.frombuffer(bin_, np.uint8, count=stride * (count - 1) + dt.itemsize * nc, offset=start)
    rows = np.lib.stride_tricks.as_strided(raw, (count, dt.itemsize * nc), (stride, 1))
    out = np.ascontiguousarray(rows).view(dt).reshape(count, nc)
    if a.get("normalized") and dt.kind in "iu":
        out = out.astype(np.float32) / np.iinfo(dt).max
    return out


def _quat_mat(q: list[float]) -> np.ndarray:
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def _local(n: dict[str, Any]) -> np.ndarray:
    if "matrix" in n:
        return np.array(n["matrix"], float).reshape(4, 4).T
    m = np.eye(4)
    m[:3, :3] = _quat_mat(n.get("rotation", [0, 0, 0, 1])) * np.array(n.get("scale", [1, 1, 1]), float)
    m[:3, 3] = n.get("translation", [0, 0, 0])
    return m


def node_worlds(js: dict[str, Any]) -> tuple[dict[int, np.ndarray], dict[int, int]]:
    nodes = js["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    W: dict[int, np.ndarray] = {}

    def w(i: int) -> np.ndarray:
        if i not in W:
            W[i] = w(parent[i]) @ _local(nodes[i]) if i in parent else _local(nodes[i])
        return W[i]

    for i in range(len(nodes)):
        w(i)
    return W, parent


# --------------------------------------------------------------------------- SAM 3D Body's fit


class Body:
    """A SAM 3D Body fit (its "Create 3D Animation File" GLB, body mesh): the body as it stands in the picture."""

    def __init__(self, path: Path):
        js, bin_ = read_glb(path)
        skin = js["skins"][0]
        self.joints: list[int] = skin["joints"]
        J = len(self.joints)
        W, parent = node_worlds(js)
        ibm = accessor(js, bin_, skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1).astype(float)
        self.posed = np.stack([W[n] for n in self.joints])          # each bone in the picture's pose
        self.template = np.stack([np.linalg.inv(m) for m in ibm])    # ...and in MHR's template (facing +Z)
        idx = {n: k for k, n in enumerate(self.joints)}
        self.parent = [idx.get(parent.get(n, -1), -1) for n in self.joints]
        mi = next(i for i, n in enumerate(js["nodes"]) if "mesh" in n and "skin" in n)
        prim = js["meshes"][js["nodes"][mi]["mesh"]]["primitives"][0]
        at = prim["attributes"]
        P = accessor(js, bin_, at["POSITION"]).astype(float)
        self.weights = np.zeros((len(P), J))
        for k in range(4):
            if f"JOINTS_{k}" not in at:
                continue
            ji = accessor(js, bin_, at[f"JOINTS_{k}"]).astype(int)
            wi = accessor(js, bin_, at[f"WEIGHTS_{k}"]).astype(float)
            for c in range(ji.shape[1]):
                np.add.at(self.weights, (np.arange(len(P)), ji[:, c]), wi[:, c])
        # the body in the picture's pose (linear blend skinning), then everything turned into the rig's frame: the
        # pelvis as it is in the template, so the person faces +Z whichever way they turned in the picture
        skinm = np.einsum("jab,jbc->jac", self.posed, ibm)
        Ph = np.c_[P, np.ones(len(P))]
        out = np.zeros((len(P), 3))
        for j in np.nonzero(self.weights.sum(0))[0]:
            w = self.weights[:, j]
            nz = w > 0
            out[nz] += w[nz, None] * (Ph[nz] @ skinm[j].T)[:, :3]
        p = BONES["pelvis"]
        self.to_rig = self.template[p] @ np.linalg.inv(self.posed[p])
        self.posed = np.einsum("ab,jbc->jac", self.to_rig, self.posed)
        self.verts = out @ self.to_rig[:3, :3].T + self.to_rig[:3, 3]
        lift = float(self.verts[:, 1].min())  # feet on the floor
        self.verts[:, 1] -= lift
        self.posed[:, 1, 3] -= lift

    def at(self, k: int) -> np.ndarray:
        return self.posed[k][:3, 3]

    def pose(self) -> dict[str, Any]:
        """The pose in the picture as the page's Person takes it (scene3d.js POSES): each arm's and leg's two bones as
        directions (x out from the body, y up, z forward), the spine as degrees (bend forward, lean to its left, twist
        to its left). The head and hands are left as they are."""
        out: dict[str, Any] = {"arms": {}, "legs": {}}
        for side, sx in (("R", -1.0), ("L", 1.0)):
            for group, key in (("arms", "arm"), ("legs", "leg")):
                a, b, c = (self.at(k) for k in BONES[f"{key}_{side}"])
                dirs = []
                for p, q in ((a, b), (b, c)):
                    d = (q - p) / max(1e-9, float(np.linalg.norm(q - p)))
                    dirs.append([round(float(d[0] * sx), 3), round(float(d[1]), 3), round(float(d[2]), 3)])
                out[group][side] = dirs
        def spine(at: Any) -> np.ndarray:
            v = at(BONES["neck"]) - at(BONES["waist"])
            d = at(BONES["arm_L"][0]) - at(BONES["arm_R"][0])
            return np.degrees([math.atan2(v[2], v[1]), math.atan2(v[0], v[1]), math.atan2(-d[2], d[0])])

        # as against the template's own (its spine curves forward a little standing straight)
        out["spine"] = [round(float(x), 1) for x in spine(self.at) - spine(lambda k: self.template[k][:3, 3])]
        out["head"] = [0, 0, 0]
        out["hands"] = {"R": "relaxed", "L": "relaxed"}
        return out


# --------------------------------------------------------------------------- the textured mesh


def _nearest(A: np.ndarray, B: np.ndarray, k: int = 1, chunk: int = 2048) -> tuple[np.ndarray, np.ndarray]:
    """For each point of A, its k nearest points of B: (distances, indices), nearest first."""
    B = B.astype(np.float32)
    bb = (B * B).sum(1)
    D = np.empty((len(A), k), np.float32)
    I = np.empty((len(A), k), np.int64)
    for s in range(0, len(A), chunk):
        a = A[s:s + chunk].astype(np.float32)
        d2 = (a * a).sum(1)[:, None] + bb[None, :] - 2 * a @ B.T
        if k == 1:
            i = d2.argmin(1)[:, None]
        else:
            i = np.argpartition(d2, k, axis=1)[:, :k]
            i = np.take_along_axis(i, np.argsort(np.take_along_axis(d2, i, 1), 1), 1)
        D[s:s + chunk] = np.sqrt(np.maximum(np.take_along_axis(d2, i, 1), 0))
        I[s:s + chunk] = i
    return D, I


def _yaw(k: int, flip: int) -> np.ndarray:
    a = k * math.pi / 2
    return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]]) @ np.diag([1, 1, flip])


def align(mesh: np.ndarray, body: np.ndarray, turn: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Line the mesh up with the body: turned as the body was from the picture's camera into the rig's frame (`turn`:
    TRELLIS.2 and SAM 3D Body both see the picture from its camera, so that's the facing; a person in an A-pose is
    nearly the same front and back, so fitting can't be trusted to find it), its height and middle, then ICP with a
    uniform scale (within 6 % in all) from the body to the mesh's nearest points, so the clothes' extra volume doesn't
    pull it off. A quarter turn about y is taken instead only when it fits far better. Returns the moved points, the
    turn applied to normals, the median gap."""
    rng = np.random.default_rng(0)
    bs = body[rng.choice(len(body), min(3000, len(body)), replace=False)]

    def fit(P: np.ndarray) -> np.ndarray:
        return (P - P.mean(0)) * (np.ptp(body[:, 1]) / max(1e-9, np.ptp(P[:, 1]))) + body.mean(0)

    ms = mesh[rng.choice(len(mesh), min(6000, len(mesh)), replace=False)]
    gaps = []
    for k in range(4):
        R = _yaw(k, 1) @ turn
        Q = fit(ms @ R.T)
        gaps.append((_nearest(Q, bs)[0].mean() + _nearest(bs, Q)[0].mean(), k, R))
    best = min(gaps, key=lambda x: x[0])
    R0 = best[2] if best[0] < 0.7 * gaps[0][0] else gaps[0][2]
    Q = fit(ms @ R0.T)
    total = 1.0
    for _ in range(30):
        _, i = _nearest(bs, Q)
        A, B = Q[i[:, 0]], bs
        ma, mb = A.mean(0), B.mean(0)
        U, S, Vt = np.linalg.svd((A - ma).T @ (B - mb))
        R = (U @ Vt).T
        if np.linalg.det(R) < 0:
            Vt[-1] *= -1
            R = (U @ Vt).T
        s = float(S.sum() / max(1e-9, ((A - ma) ** 2).sum()))
        s = float(np.clip(total * s, 0.94, 1.06)) / total
        total *= s
        Q = (Q - ma) @ R.T * s + mb
    # the same moves for the whole mesh: replay them as one similarity from the sample's start to its end
    start = fit(ms @ R0.T)
    ma, mb = start.mean(0), Q.mean(0)
    U, S, Vt = np.linalg.svd((start - ma).T @ (Q - mb))
    R = (U @ Vt).T
    if np.linalg.det(R) < 0:
        Vt[-1] *= -1
        R = (U @ Vt).T
    s = float(S.sum() / max(1e-9, ((start - ma) ** 2).sum()))
    full = (fit(mesh @ R0.T) - ma) @ R.T * s + mb
    gap = float(np.median(_nearest(full[rng.choice(len(full), min(8000, len(full)), replace=False)], body)[0]))
    return full, R @ R0, gap


def _write_glb(path: Path, js: dict[str, Any], bin_out: bytearray) -> None:
    while len(bin_out) % 4:
        bin_out.append(0)
    js["buffers"] = [{"byteLength": len(bin_out)}]
    jb = json.dumps(js, separators=(",", ":")).encode()
    jb += b" " * (-len(jb) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(jb) + 8 + len(bin_out)))
        f.write(struct.pack("<II", len(jb), 0x4E4F534A))
        f.write(jb)
        f.write(struct.pack("<II", len(bin_out), 0x004E4942))
        f.write(bytes(bin_out))


def build(apose_body: Path, photo_body: Path | None, mesh_glb: Path, out_glb: Path) -> dict[str, Any]:
    """The rigged figure (out_glb: the textured mesh skinned to the skeleton in its A-pose, in the rig's frame) and its
    rig for the page: each bone's place, its parent, the named bones, the figure's height, the picture's pose."""
    body = Body(apose_body)
    tjs, tbin = read_glb(mesh_glb)
    tW, _ = node_worlds(tjs)
    prims, pts = [], []
    for ni, n in enumerate(tjs["nodes"]):
        if "mesh" not in n:
            continue
        for p in tjs["meshes"][n["mesh"]]["primitives"]:
            if p.get("mode", 4) != 4:
                continue
            P = accessor(tjs, tbin, p["attributes"]["POSITION"]).astype(float)
            P = P @ tW[ni][:3, :3].T + tW[ni][:3, 3]
            prims.append((p, len(P), tW[ni][:3, :3]))
            pts.append(P)
    if not prims:
        raise ValueError("The 3D model has no mesh")
    mesh = np.concatenate(pts)
    Q, Rn, gap = align(mesh, body.verts, body.to_rig[:3, :3])
    if gap > 0.08:
        raise ValueError(f"The 3D model and the body fitted to the picture don't line up (they're {gap * 100:.0f} cm apart)")
    # each vertex: the inverse-distance blend of its 8 nearest body vertices' weights, kept to the 4 largest
    d, i = _nearest(Q, body.verts, k=8)
    w = 1.0 / np.maximum(d.astype(float), 1e-4) ** 2
    w /= w.sum(1, keepdims=True)
    J = len(body.joints)
    top = np.zeros((len(Q), 4), np.int64)
    tw = np.zeros((len(Q), 4))
    for s in range(0, len(Q), 4096):
        Wq = np.einsum("nk,nkj->nj", w[s:s + 4096], body.weights[i[s:s + 4096]])
        t = np.argsort(-Wq, 1)[:, :4]
        top[s:s + 4096] = t
        tw[s:s + 4096] = np.take_along_axis(Wq, t, 1)
    tw /= np.maximum(tw.sum(1, keepdims=True), 1e-9)

    # --- the GLB: the mesh (its UVs, normals, material and pictures as they were), the skeleton in this A-pose
    out = bytearray()
    views: list[dict[str, Any]] = []
    accs: list[dict[str, Any]] = []

    def add(arr: np.ndarray, comp: int, typ: str, target: int | None = None, minmax: bool = False) -> int:
        arr = np.ascontiguousarray(arr)
        while len(out) % 4:
            out.append(0)
        views.append({"buffer": 0, "byteOffset": len(out), "byteLength": arr.nbytes, **({"target": target} if target else {})})
        out.extend(arr.tobytes())
        a: dict[str, Any] = {"bufferView": len(views) - 1, "componentType": comp, "count": len(arr), "type": typ}
        if minmax:
            a["min"], a["max"] = arr.min(0).tolist(), arr.max(0).tolist()
        accs.append(a)
        return len(accs) - 1

    images = []
    for im in tjs.get("images", []):
        bv = tjs["bufferViews"][im["bufferView"]]
        blob = tbin[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
        while len(out) % 4:
            out.append(0)
        views.append({"buffer": 0, "byteOffset": len(out), "byteLength": len(blob)})
        out.extend(blob)
        images.append({"bufferView": len(views) - 1, "mimeType": im.get("mimeType", "image/png")})
    primitives, o = [], 0
    for p, n, M in prims:
        at = {"POSITION": add(Q[o:o + n].astype(np.float32), 5126, "VEC3", 34962, True)}
        if "NORMAL" in p["attributes"]:
            N = accessor(tjs, tbin, p["attributes"]["NORMAL"]).astype(float) @ (Rn @ M).T
            N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
            at["NORMAL"] = add(N.astype(np.float32), 5126, "VEC3", 34962)
        if "TEXCOORD_0" in p["attributes"]:
            at["TEXCOORD_0"] = add(accessor(tjs, tbin, p["attributes"]["TEXCOORD_0"]).astype(np.float32), 5126, "VEC2", 34962)
        at["JOINTS_0"] = add(top[o:o + n].astype(np.uint16), 5123, "VEC4", 34962)
        at["WEIGHTS_0"] = add(tw[o:o + n].astype(np.float32), 5126, "VEC4", 34962)
        prim: dict[str, Any] = {"attributes": at}
        if "indices" in p:
            prim["indices"] = add(accessor(tjs, tbin, p["indices"]).astype(np.uint32).ravel(), 5125, "SCALAR", 34963)
        if "material" in p:
            prim["material"] = p["material"]
        primitives.append(prim)
        o += n
    # the skeleton: a node per bone at its place in this A-pose (its local turn kept, so Blender shows sensible bones)
    nodes: list[dict[str, Any]] = []
    for k in range(J):
        Wk = body.posed[k]
        Lk = Wk if body.parent[k] < 0 else np.linalg.inv(body.posed[body.parent[k]]) @ Wk
        nodes.append({"name": f"bone_{k:03d}", "matrix": Lk.T.ravel().round(7).tolist()})
    for k in range(J):
        kids = [c for c in range(J) if body.parent[c] == k]
        if kids:
            nodes[k]["children"] = kids
    roots = [k for k in range(J) if body.parent[k] < 0]
    ibm = np.stack([np.linalg.inv(body.posed[k]) for k in range(J)]).transpose(0, 2, 1).astype(np.float32).reshape(-1, 16)
    nodes.append({"name": "figure", "mesh": 0, "skin": 0})
    js: dict[str, Any] = {"asset": {"version": "2.0", "generator": "Bob Studio Make 3D figure"}, "scene": 0,
                          "scenes": [{"nodes": roots + [J]}], "nodes": nodes,
                          "meshes": [{"name": "figure", "primitives": primitives}],
                          "skins": [{"joints": list(range(J)), "inverseBindMatrices": add(ibm, 5126, "MAT4"), "skeleton": roots[0]}],
                          "accessors": accs, "bufferViews": views}
    if images:
        js["images"] = images
        js["samplers"] = [{"magFilter": 9729, "minFilter": 9987}]
        js["textures"] = [{"source": t["source"], "sampler": 0} for t in tjs.get("textures", [])]
    if tjs.get("materials"):
        js["materials"] = tjs["materials"]
    _write_glb(out_glb, js, out)
    rig = {"bones": BONES, "parent": body.parent, "joints": [[round(float(x), 5) for x in body.at(k)] for k in range(J)],
           "height": round(float(np.ptp(Q[:, 1])), 4), "gap": round(gap, 4), "vertices": int(len(Q))}
    if photo_body:
        rig["pose"] = Body(photo_body).pose()
    return rig
