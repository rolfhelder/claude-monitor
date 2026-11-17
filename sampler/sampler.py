#!/usr/bin/env python3
"""RAM/CPU sampler for macOS. launchd runs it every N seconds.

  sampler.py [--detailed] [--hung-apps]   take one sample and append it to the log
  sampler.py --once --stdout              take one sample and print it
  sampler.py report [--since 2h] [--date YYYY-MM-DD]

Logs go to ~/Library/Logs/claude-monitor/YYYY-MM-DD.jsonl (kept 14 days) and
the newest sample to latest.json in the same folder. Nothing leaves the Mac.
"""
import ctypes
import ctypes.util
import datetime as dt
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

LOG_DIR = os.environ.get("CLAUDE_MONITOR_LOG_DIR") or os.path.expanduser("~/Library/Logs/claude-monitor")
STATE = os.path.join(LOG_DIR, ".cpu-ticks.json")
HUNG_STATE = os.path.join(LOG_DIR, ".hung-check")
SUPPORT_DIR = os.path.expanduser("~/Library/Application Support/claude-monitor")
SEEN = os.path.join(SUPPORT_DIR, "last-seen")
LABEL = "io.github.rolfhelder.claude-monitor"
RETIRE_DAYS = 30
ERR_CAP = 1 << 20
KEEP_DAYS = 14
TOP_N = 12
GROUPS_N = 10
HUNG_EVERY_S = 60
GB = 2**30

_libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)


def sysctl(name, ctype):
    val = ctype()
    size = ctypes.c_size_t(ctypes.sizeof(val))
    if _libc.sysctlbyname(name.encode(), ctypes.byref(val), ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
        return None
    return val


class LoadAvg(ctypes.Structure):
    _fields_ = [("ldavg", ctypes.c_uint32 * 3), ("fscale", ctypes.c_long)]


class XswUsage(ctypes.Structure):
    _fields_ = [("total", ctypes.c_uint64), ("avail", ctypes.c_uint64), ("used", ctypes.c_uint64),
                ("pagesize", ctypes.c_uint32), ("encrypted", ctypes.c_bool)]


class VmStats64(ctypes.Structure):
    _fields_ = [("free", ctypes.c_uint32), ("active", ctypes.c_uint32), ("inactive", ctypes.c_uint32),
                ("wired", ctypes.c_uint32)] + \
               [(n, ctypes.c_uint64) for n in ("zero_fill", "reactivations", "pageins", "pageouts", "faults",
                                               "cow_faults", "lookups", "hits", "purges")] + \
               [("purgeable", ctypes.c_uint32), ("speculative", ctypes.c_uint32)] + \
               [(n, ctypes.c_uint64) for n in ("decompressions", "compressions", "swapins", "swapouts")] + \
               [("compressor", ctypes.c_uint32), ("throttled", ctypes.c_uint32), ("external", ctypes.c_uint32),
                ("internal", ctypes.c_uint32), ("uncompressed_in_compressor", ctypes.c_uint64)]


HOST_VM_INFO64 = 4
HOST_CPU_LOAD_INFO = 3


def _host():
    _libc.mach_host_self.restype = ctypes.c_uint32
    return _libc.mach_host_self()


def vm_stats():
    """Page counts in bytes, from host_statistics64; vm_stat as a fallback."""
    page = sysctl("hw.pagesize", ctypes.c_int64)
    page = page.value if page else 4096
    st = VmStats64()
    count = ctypes.c_uint32(ctypes.sizeof(st) // 4)
    if _libc.host_statistics64(_host(), HOST_VM_INFO64, ctypes.byref(st), ctypes.byref(count)) == 0:
        return {f: getattr(st, f) * page for f in ("free", "wired", "purgeable", "compressor", "external", "internal")}
    return _vm_stat_fallback()


def _vm_stat_fallback(text=None):
    if text is None:
        text = subprocess.run(["/usr/bin/vm_stat"], capture_output=True, text=True).stdout
    out = text.splitlines()
    m = re.search(r"page size of (\d+)", out[0] if out else "")
    page = int(m.group(1)) if m else 4096
    raw = {}
    for line in out[1:]:
        k, _, v = line.partition(":")
        v = v.strip().rstrip(".")
        if v.isdigit():
            raw[k.strip()] = int(v) * page
    keys = {"free": "Pages free", "wired": "Pages wired down", "purgeable": "Pages purgeable",
            "compressor": "Pages occupied by compressor", "external": "File-backed pages",
            "internal": "Anonymous pages"}
    return {k: raw.get(v, 0) for k, v in keys.items()}


def cpu_ticks():
    ticks = (ctypes.c_uint32 * 4)()
    count = ctypes.c_uint32(4)
    if _libc.host_statistics(_host(), HOST_CPU_LOAD_INFO, ticks, ctypes.byref(count)) != 0:
        return None
    return list(ticks)  # user, system, idle, nice


def busy_fraction(prev, cur):
    if not prev or not cur or len(prev) != 4:
        return None
    d = [max(0, c - p) for c, p in zip(cur, prev)]
    total = sum(d)
    return (d[0] + d[1] + d[3]) / total if total else None


def cpu_busy(cores):
    """Busy vCPUs since the previous run, from tick deltas kept in a state file."""
    cur = cpu_ticks()
    try:
        with open(STATE) as f:
            prev = json.load(f)
    except Exception:
        prev = None
    if prev is None and cur is not None:
        time.sleep(0.1)
        prev, cur = cur, cpu_ticks()
    try:
        tmp = f"{STATE}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(cur, f)
        os.replace(tmp, STATE)
    except Exception:
        pass
    frac = busy_fraction(prev, cur)
    return round(frac * cores, 2) if frac is not None else None


def system():
    vm = vm_stats()
    return system_from(vm)


def memory(vm):
    """Activity Monitor: Memory Used = app (anonymous - purgeable) + wired + compressed; Cached = file-backed + purgeable."""
    return {"used_gb": round((vm["internal"] - vm["purgeable"] + vm["wired"] + vm["compressor"]) / GB, 2),
            "cached_gb": round((vm["external"] + vm["purgeable"]) / GB, 2)}


def system_from(vm):
    cores = sysctl("hw.ncpu", ctypes.c_int)
    cores = cores.value if cores else os.cpu_count() or 1
    total = sysctl("hw.memsize", ctypes.c_uint64)
    swap = sysctl("vm.swapusage", XswUsage)
    load = sysctl("vm.loadavg", LoadAvg)
    level = sysctl("kern.memorystatus_vm_pressure_level", ctypes.c_int)
    level = level.value if level else None
    return {
        "total_gb": round(total.value / GB, 2) if total else None,
        **memory(vm),
        "free_gb": round(vm["free"] / GB, 2),
        "wired_gb": round(vm["wired"] / GB, 2),
        "compressed_gb": round(vm["compressor"] / GB, 2),
        "swap_used_gb": round(swap.used / GB, 2) if swap else None,
        "pressure": {1: "normal", 2: "warn", 4: "critical"}.get(level, "unknown"),
        "load1": round(load.ldavg[0] / load.fscale, 2) if load and load.fscale else None,
        "cores": cores,
        "cpu_used": cpu_busy(cores),
    }


def app_group(path):
    """Outermost .app bundle name, else the executable's name."""
    m = re.search(r"/([^/]+)\.app/", path)
    return m.group(1) if m else os.path.basename(path)


def processes(detailed):
    out = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,rss=,%cpu=,comm="],
                         capture_output=True, text=True, timeout=10).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid, ppid, rss, cpu, comm = parts
        try:
            rows.append({"pid": int(pid), "ppid": int(ppid), "mb": int(rss) // 1024, "cpu": float(cpu), "path": comm})
        except ValueError:
            continue
    groups = {}
    for r in rows:
        g = groups.setdefault(app_group(r["path"]), [0, 0, 0.0])
        g[0] += 1
        g[1] += r["mb"]
        g[2] += r["cpu"]
    groups = {k: {"n": v[0], "mb": v[1], "cpu": round(v[2], 1)}
              for k, v in sorted(groups.items(), key=lambda kv: -kv[1][1])[:GROUPS_N]}
    by_mem = sorted(rows, key=lambda r: -r["mb"])[:TOP_N]
    seen = {r["pid"] for r in by_mem}
    picked = by_mem + [r for r in sorted(rows, key=lambda r: -r["cpu"])[:TOP_N] if r["pid"] not in seen]
    workspaces = workspace_names(rows, picked) if detailed else {}
    top = []
    for r in picked:
        p = {"pid": r["pid"], "mb": r["mb"], "cpu": r["cpu"], "name": os.path.basename(r["path"])}
        if detailed:
            p["path"] = r["path"]
            if r["pid"] in workspaces:
                p["ws"] = workspaces[r["pid"]]
        top.append(p)
    return top, groups


def workspace_names(rows, picked):
    """Detailed mode only, and only when cmux is installed: terminal workspace per process."""
    cmux = shutil.which("cmux") or ("/Applications/cmux.app/Contents/Resources/bin/cmux"
                                    if os.path.exists("/Applications/cmux.app/Contents/Resources/bin/cmux") else None)
    if not cmux:
        return {}
    try:
        listing = subprocess.run([cmux, "workspace", "list", "--id-format", "both"],
                                 capture_output=True, text=True, timeout=3).stdout
        env = subprocess.run(["/bin/ps", "-axeww", "-o", "pid=,command="],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return {}
    names = {}
    for line in listing.splitlines():
        m = re.match(r"\s*\S+\s+([0-9A-Fa-f-]{36})\s+(.*?)(\s+\[selected\])?\s*$", line)
        if m:
            names[m.group(1).upper()] = m.group(2).strip()
    ws_of = {}
    for line in env.splitlines():
        m = re.match(r"\s*(\d+)\s.*?CMUX_WORKSPACE_ID=([0-9A-Fa-f-]{36})", line)
        if m:
            ws_of[int(m.group(1))] = m.group(2).upper()
    parent = {r["pid"]: r["ppid"] for r in rows}
    found = {}
    for r in picked:
        p, hops = r["pid"], 0
        while p and p > 1 and hops < 15:
            if p in ws_of:
                found[r["pid"]] = names.get(ws_of[p], "closed workspace")
                break
            p, hops = parent.get(p), hops + 1
    return found


HUNG_SCRIPT = '''
set out to ""
tell application "System Events"
  set procs to every process whose background only is false
  repeat with p in procs
    set n to ""
    try
      set n to name of p
      with timeout of 2 seconds
        get frontmost of p
      end timeout
    on error errMsg number errNum
      if errNum is -1712 then
        set out to out & "hung" & tab & n & linefeed
      else
        set out to out & "unknown" & tab & n & linefeed
      end if
    end try
  end repeat
end tell
return out
'''


def hung_apps():
    """One osascript call, at most once a minute. -1712 is a timeout (hung); other errors are unknown."""
    try:
        if time.time() - os.path.getmtime(HUNG_STATE) < HUNG_EVERY_S:
            return None
    except OSError:
        pass
    open(HUNG_STATE, "w").close()
    try:
        r = subprocess.run(["/usr/bin/osascript", "-"], input=HUNG_SCRIPT, capture_output=True, text=True, timeout=20)
    except Exception:
        return {"hung": [], "unknown": ["*"]}
    if r.returncode != 0:
        return {"hung": [], "unknown": ["*"]}
    res = {"hung": [], "unknown": []}
    for line in r.stdout.splitlines():
        kind, _, name = line.partition("\t")
        if kind in res:
            res[kind].append(name)
    return res


def last_line(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 65536))
            return json.loads(f.read().splitlines()[-1])
    except Exception:
        return None


def take(detailed=False, hung=False, prev=None):
    now = time.time()
    s = system()
    top, groups = processes(detailed)
    rec = {"t": dt.datetime.fromtimestamp(now).astimezone().isoformat(timespec="seconds"),
           "ts": round(now, 3), "sys": s, "groups": groups, "top": top}
    swap_jump = bool(prev and s["swap_used_gb"] is not None and prev.get("sys", {}).get("swap_used_gb") is not None
                     and s["swap_used_gb"] - prev["sys"]["swap_used_gb"] > 0.5)
    if s["pressure"] not in ("normal", "unknown") or swap_jump:
        rec["alert"] = {"pressure": s["pressure"], "swap_jump": swap_jump}
        if hung:
            h = hung_apps()
            if h is not None:
                rec["alert"].update(h)
    return rec


def previous(path):
    """Last sample of today, else latest.json (yesterday's last one just after midnight)."""
    prev = last_line(path)
    if prev is None:
        try:
            with open(os.path.join(LOG_DIR, "latest.json")) as f:
                prev = json.load(f)
        except Exception:
            prev = None
    return prev


def retire_if_orphaned():
    """Stops the agent when no Claude Code session with the plugin has started for RETIRE_DAYS."""
    try:
        if time.time() - os.path.getmtime(SEEN) < RETIRE_DAYS * 86400:
            return False
    except OSError:
        return False
    plist = os.path.expanduser(f"~/Library/LaunchAgents/{LABEL}.plist")
    try:
        os.remove(plist)
    except OSError:
        pass
    subprocess.run(["/bin/launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    return True


def cap_err_log():
    err = os.path.join(LOG_DIR, "sampler.err")
    try:
        if os.path.getsize(err) > ERR_CAP:
            open(err, "w").close()
    except OSError:
        pass


def prune(cutoff):
    for old in glob.glob(os.path.join(LOG_DIR, "*.jsonl")):
        if os.path.getmtime(old) < cutoff:
            os.remove(old)


def sample(detailed, hung):
    if retire_if_orphaned():
        return
    os.makedirs(LOG_DIR, exist_ok=True)
    cap_err_log()
    path = os.path.join(LOG_DIR, dt.date.today().isoformat() + ".jsonl")
    rec = take(detailed, hung, previous(path))
    line = json.dumps(rec, separators=(",", ":"))
    with open(path, "a") as f:
        f.write(line + "\n")
    latest = os.path.join(LOG_DIR, "latest.json")
    tmp = f"{latest}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        f.write(line)
    os.replace(tmp, latest)
    prune(time.time() - KEEP_DAYS * 86400)


SINCE = re.compile(r"(\d{1,4})([mhd])")


def parse_since(s):
    m = SINCE.fullmatch(s or "")
    if not m or int(m.group(1)) == 0:
        raise ValueError(f"--since takes a duration like 30m, 2h or 3d, not {s!r}")
    return dt.timedelta(**{{"m": "minutes", "h": "hours", "d": "days"}[m.group(2)]: int(m.group(1))})


def flag(args, name):
    if name not in args:
        return None
    i = args.index(name)
    if i + 1 >= len(args):
        raise ValueError(f"{name} needs a value")
    return args[i + 1]


def report(args):
    since = parse_since(flag(args, "--since") or "24h")
    date = flag(args, "--date")
    if date is not None:
        try:
            dt.date.fromisoformat(date)
        except ValueError:
            raise ValueError(f"--date takes YYYY-MM-DD, not {date!r}")
        files = [os.path.join(LOG_DIR, date + ".jsonl")]
    else:
        days = since.days + 2
        files = sorted(glob.glob(os.path.join(LOG_DIR, "*.jsonl")))[-days:]
    start = time.time() - since.total_seconds()
    recs = []
    for f in files:
        try:
            fh = open(f)
        except OSError:
            continue
        with fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if date or r.get("ts", 0) >= start:
                    recs.append(r)
    if not recs:
        print("no samples")
        return
    print(f"{len(recs)} samples {recs[0]['t']} -> {recs[-1]['t']}")
    peak = max(recs, key=lambda r: r["sys"].get("used_gb") or 0)
    s = peak["sys"]
    print(f"peak RAM at {peak['t']}: used {s.get('used_gb')} GB, cache {s.get('cached_gb')} GB, "
          f"swap {s.get('swap_used_gb')} GB, pressure {s.get('pressure')}, CPU {s.get('cpu_used')}/{s.get('cores')}")
    print("  groups:", ", ".join(f"{k} {v['mb']}MB/{v['cpu']}%" for k, v in list(peak["groups"].items())[:6]))
    for p in peak["top"][:8]:
        tag = f"  {p['ws']}" if p.get("ws") else ""
        print(f"  {p['pid']:>7} {p['mb']:>6} MB {p['cpu']:>5}%  {p.get('name', '')[:45]}{tag}")
    busiest = max(recs, key=lambda r: r["sys"].get("cpu_used") or 0)
    print(f"peak CPU at {busiest['t']}: {busiest['sys'].get('cpu_used')}/{busiest['sys'].get('cores')} busy")
    alerts = [r for r in recs if "alert" in r]
    print(f"\n{len(alerts)} alert samples")
    for r in alerts[:40]:
        a = r["alert"]
        extra = ""
        if "hung" in a:
            extra = f" hung={','.join(a['hung']) or '-'} unknown={len(a.get('unknown', []))}"
        print(f"  {r['t']} pressure={a['pressure']} swap_jump={a['swap_jump']} swap={r['sys']['swap_used_gb']}GB{extra}")


def main(argv):
    if sys.platform != "darwin":
        print("claude-monitor runs on macOS only.", file=sys.stderr)
        return 2
    try:
        if argv[:1] == ["report"]:
            report(argv[1:])
            return 0
        detailed, hung = "--detailed" in argv, "--hung-apps" in argv
        if "--stdout" in argv:
            print(json.dumps(take(detailed, hung), indent=1))
        else:
            sample(detailed, hung)
        return 0
    except ValueError as e:
        print(e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
