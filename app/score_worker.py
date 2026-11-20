"""Measurements for Score (app/score.py), run with ComfyUI's own Python, which has numpy, OpenCV, PyAV and
InsightFace, so the studio itself needs none of them. Standalone: no studio imports.

    python score_worker.py job.json   ->   one JSON object on stdout

job: {media, kind: "video"|"image", out_dir, frames: N to save for the vision model, refs: [picture paths],
      insightface_root (the folder holding models/buffalo_l), motion_ref, motion_mask (a 3D scene render's rough
      animation and mask, conformed to the output's size and length), camera_expected: [words]}
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np


def read_video(path: str, max_frames: int | None = None) -> tuple[list[np.ndarray], dict]:
    import av
    frames, info = [], {}
    with av.open(path) as c:
        vs = next((s for s in c.streams if s.type == "video"), None)
        info["has_audio"] = any(s.type == "audio" for s in c.streams)
        if vs is None:
            return [], info
        info["fps"] = float(vs.average_rate or vs.guessed_rate or 0)
        info["width"], info["height"] = vs.codec_context.width, vs.codec_context.height
        info["duration"] = float(c.duration / 1e6) if c.duration else None
        for f in c.decode(vs):
            frames.append(f.to_ndarray(format="bgr24"))
            if max_frames and len(frames) >= max_frames:
                break
    info["frames"] = len(frames)
    if not info.get("duration") and info.get("fps"):
        info["duration"] = len(frames) / info["fps"]
    return frames, info


def pick(n_total: int, n: int, lo: float = 0.04, hi: float = 0.96) -> list[int]:
    if n_total <= 0:
        return []
    if n <= 1:
        return [n_total // 2]
    return sorted({min(n_total - 1, max(0, round((lo + (hi - lo) * i / (n - 1)) * (n_total - 1)))) for i in range(n)})


def save_frames(frames: list[np.ndarray], idx: list[int], out: Path, long_side: int = 768) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    for k, i in enumerate(idx):
        f = frames[i]
        h, w = f.shape[:2]
        s = long_side / max(h, w)
        if s < 1:
            f = cv2.resize(f, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
        p = out / f"frame_{k:02d}.jpg"
        cv2.imwrite(str(p), f, [cv2.IMWRITE_JPEG_QUALITY, 90])
        paths.append(str(p))
    return paths


# ---------------------------------------------------------------- reference identity (InsightFace, ArcFace)
def identity(frames: list[np.ndarray], refs: list[str], root: str) -> dict:
    from insightface.app import FaceAnalysis
    fa = FaceAnalysis(name="buffalo_l", root=root, providers=["CPUExecutionProvider"], allowed_modules=["detection", "recognition"])
    fa.prepare(ctx_id=-1, det_size=(640, 640))

    def up(img, long_side=1600):  # small faces (a draft video) embed poorly: give the detector more pixels
        h, w = img.shape[:2]
        k = long_side / max(h, w)
        return cv2.resize(img, (round(w * k), round(h * k)), interpolation=cv2.INTER_CUBIC) if k > 1.05 else img

    def faces_in(img):
        big = up(img)
        k = img.shape[1] / big.shape[1]  # to the picture's own pixels
        found = fa.get(big)
        # a face still small: look again in a close crop round it, enlarged; each face keeps its width in the picture
        out = []
        for f in found:
            x0, y0, x1, y1 = f.bbox
            f.px = float(x1 - x0) * k
            if x1 - x0 >= 160:
                out.append(f); continue
            big = up(img)
            cx, cy, r = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) * 1.6
            H, W = big.shape[:2]
            crop = big[max(0, int(cy - r)):min(H, int(cy + r)), max(0, int(cx - r)):min(W, int(cx + r))]
            again = fa.get(up(crop, 640)) if crop.size else []
            g = max(again, key=lambda g: (g.bbox[2] - g.bbox[0]) * (g.bbox[3] - g.bbox[1])) if again else f
            g.px = f.px
            out.append(g)
        return out

    def biggest(img):
        faces = faces_in(img)
        return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])) if faces else None

    out = []
    for r in refs:
        img = cv2.imread(r)
        if img is None:
            out.append({"ref": r, "face": False}); continue
        f0 = biggest(img)
        if f0 is None:
            out.append({"ref": r, "face": False}); continue
        e0 = f0.normed_embedding
        sims, px = [], []
        for fr in frames:
            faces = faces_in(fr)
            best = max(faces, key=lambda f: float(np.dot(e0, f.normed_embedding)), default=None)
            sims.append(float(np.dot(e0, best.normed_embedding)) if best is not None else None)
            if best is not None:
                px.append(best.px)
        seen = [x for x in sims if x is not None]
        out.append({"ref": r, "face": True, "frames": len(frames), "with_face": len(seen),
                    "mean": round(float(np.mean(seen)), 3) if seen else None, "min": round(float(min(seen)), 3) if seen else None,
                    "face_px": round(float(np.median(px))) if px else None})
    return {"refs": out}


# ---------------------------------------------------------------- camera
def global_motion(a: np.ndarray, b: np.ndarray) -> dict | None:
    """How the picture moved from a to b: tracked corners -> a similarity transform (shift, zoom, turn)."""
    ga, gb = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    pts = cv2.goodFeaturesToTrack(ga, maxCorners=400, qualityLevel=0.01, minDistance=8)
    if pts is None or len(pts) < 12:
        return None
    nxt, st, _ = cv2.calcOpticalFlowPyrLK(ga, gb, pts, None)
    ok = st.reshape(-1) == 1
    if ok.sum() < 12:
        return None
    M, inl = cv2.estimateAffinePartial2D(pts[ok], nxt[ok], method=cv2.RANSAC, ransacReprojThreshold=2.0)
    if M is None:
        return None
    h, w = ga.shape
    s = math.hypot(M[0, 0], M[1, 0])
    return {"dx": float(M[0, 2] + (M[0, 0] - 1) * w / 2 + M[0, 1] * h / 2) / w, "dy": float(M[1, 2] + M[1, 0] * w / 2 + (M[1, 1] - 1) * h / 2) / h,
            "zoom": float(s), "turn": float(math.degrees(math.atan2(M[1, 0], M[0, 0])))}


def motion_track(frames: list[np.ndarray], steps: int = 24) -> dict:
    """The camera's apparent move over the clip: summed shifts (fractions of the frame), zoom and turn."""
    idx = pick(len(frames), steps + 1, 0.0, 1.0)
    tot = {"dx": 0.0, "dy": 0.0, "zoom": 1.0, "turn": 0.0}
    per = []
    for i, j in zip(idx, idx[1:]):
        m = global_motion(frames[i], frames[j])
        if not m:
            continue
        tot["dx"] += m["dx"]; tot["dy"] += m["dy"]; tot["zoom"] *= m["zoom"]; tot["turn"] += m["turn"]
        per.append(m)
    return {**{k: round(v, 4) for k, v in tot.items()}, "steps": len(per)}


def classify(t: dict) -> list[str]:
    """Words for an apparent move (content shifting right means the camera panned or trucked left)."""
    words = []
    if t["zoom"] > 1.06: words.append("in")
    if t["zoom"] < 0.94: words.append("out")
    if t["dx"] > 0.06: words.append("left")
    if t["dx"] < -0.06: words.append("right")
    if t["dy"] > 0.06: words.append("up")
    if t["dy"] < -0.06: words.append("down")
    if abs(t["turn"]) > 3: words.append("roll")
    return words or ["static"]


def edge_match(a: np.ndarray, b: np.ndarray, mask: np.ndarray | None) -> float | None:
    """How much of a's outline (the camera move H3 was given) lies within 3 px of b's (the video), in the mask."""
    ea = cv2.Canny(cv2.GaussianBlur(cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), (5, 5), 0), 60, 140) > 0
    eb = cv2.Canny(cv2.GaussianBlur(cv2.cvtColor(b, cv2.COLOR_BGR2GRAY), (5, 5), 0), 40, 120)
    if mask is not None:
        ea &= mask
    if ea.sum() < 200:
        return None
    dist = cv2.distanceTransform((eb == 0).astype(np.uint8), cv2.DIST_L2, 3)
    return float((dist[ea] <= 3).mean())


def camera(frames: list[np.ndarray], motion_ref: str | None, motion_mask: str | None, expected: list[str]) -> dict:
    out: dict = {"track": motion_track(frames)}
    out["seen"] = classify(out["track"])
    if motion_ref:
        rf, _ = read_video(motion_ref)
        mk, _ = read_video(motion_mask) if motion_mask else ([], {})
        n = min(len(rf), len(frames))
        idx = pick(n, 12, 0.08, 1.0)
        h, w = frames[0].shape[:2]
        matches = []
        for i in idx:
            a = cv2.resize(rf[i], (w, h)) if rf[i].shape[:2] != (h, w) else rf[i]
            m = None
            if i < len(mk):
                m = cv2.resize(mk[i], (w, h))[:, :, 2] > 127
                m = cv2.dilate(m.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            e = edge_match(a, frames[i], m)
            if e is not None:
                matches.append(e)
        out["edges"] = round(float(np.mean(matches)), 3) if matches else None
        ref_track = motion_track(rf[:n])
        out["ref_track"] = ref_track
        # the two moves, as vectors: same direction and size?
        va = np.array([ref_track["dx"], ref_track["dy"], math.log(ref_track["zoom"]), ref_track["turn"] / 30])
        vb = np.array([out["track"]["dx"], out["track"]["dy"], math.log(out["track"]["zoom"]), out["track"]["turn"] / 30])
        na, nb = float(np.linalg.norm(va)), float(np.linalg.norm(vb))
        if na < 0.03 and nb < 0.03:
            out["path"] = 1.0
        elif na < 0.03 or nb < 0.03:
            out["path"] = 0.2
        else:
            cos = float(np.dot(va, vb) / (na * nb))
            out["path"] = round(max(0.0, cos) * min(na, nb) / max(na, nb), 3)
    out["expected"] = expected
    return out


def main() -> None:
    job = json.loads(Path(sys.argv[1]).read_text("utf-8"))
    res: dict = {}
    if job["kind"] == "video":
        frames, info = read_video(job["media"])
        res["probe"] = info
        if not frames:
            raise SystemExit(json.dumps({"error": "no video frames"}))
        res["frames"] = save_frames(frames, pick(len(frames), job.get("frames", 4), 0.08, 0.92), Path(job["out_dir"]))
        sample = [frames[i] for i in pick(len(frames), 12)]
        res["camera"] = camera(frames, job.get("motion_ref"), job.get("motion_mask"), job.get("camera_expected") or [])
    else:
        img = cv2.imread(job["media"])
        if img is None:
            raise SystemExit(json.dumps({"error": "unreadable picture"}))
        res["probe"] = {"width": img.shape[1], "height": img.shape[0]}
        res["frames"] = save_frames([img], [0], Path(job["out_dir"]), 1024)
        sample = [img]
    if job.get("refs"):
        try:
            res["identity"] = identity(sample, job["refs"], job["insightface_root"])
        except Exception as exc:  # noqa: BLE001
            res["identity"] = {"error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(res))


if __name__ == "__main__":
    main()
