"""Run: python3 -I sampler/test_sampler.py"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLER = os.path.join(HERE, "sampler.py")
spec = importlib.util.spec_from_file_location("sampler", SAMPLER)
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)


VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               100000.
Pages wired down:                         200000.
Pages purgeable:                           10000.
Pages occupied by compressor:              50000.
File-backed pages:                        300000.
Anonymous pages:                          900000.
"""


class Pure(unittest.TestCase):
    def test_memory_math_from_vm_stat(self):
        vm = sampler._vm_stat_fallback(VM_STAT)
        self.assertEqual(vm["internal"], 900000 * 16384)
        m = sampler.memory(vm)
        page_gb = 16384 / 2**30
        self.assertAlmostEqual(m["used_gb"], (900000 - 10000 + 200000 + 50000) * page_gb, places=2)
        self.assertAlmostEqual(m["cached_gb"], (300000 + 10000) * page_gb, places=2)

    def test_page_size_comes_from_header(self):
        vm = sampler._vm_stat_fallback(VM_STAT.replace("16384", "4096"))
        self.assertEqual(vm["free"], 100000 * 4096)

    def test_retention(self):
        with tempfile.TemporaryDirectory() as d:
            old, new = os.path.join(d, "2020-01-01.jsonl"), os.path.join(d, "2020-01-20.jsonl")
            for f in (old, new):
                open(f, "w").close()
            os.utime(old, (1000, 1000))
            os.utime(new, (5000, 5000))
            saved, sampler.LOG_DIR = sampler.LOG_DIR, d
            try:
                sampler.prune(3000)
            finally:
                sampler.LOG_DIR = saved
            self.assertEqual(os.listdir(d), ["2020-01-20.jsonl"])

    def test_busy_fraction(self):
        self.assertAlmostEqual(sampler.busy_fraction([0, 0, 0, 0], [30, 10, 50, 10]), 0.5)
        self.assertIsNone(sampler.busy_fraction(None, [1, 1, 1, 1]))

    def test_app_group(self):
        self.assertEqual(sampler.app_group("/Applications/Foo Bar.app/Contents/Frameworks/Helper.app/Contents/MacOS/H"), "Foo Bar")
        self.assertEqual(sampler.app_group("/usr/bin/python3"), "python3")

    def test_parse_since(self):
        self.assertEqual(sampler.parse_since("2h").total_seconds(), 7200)
        for bad in ("", "2x", "h", "0m", "-1h"):
            self.assertRaises(ValueError, sampler.parse_since, bad)


@unittest.skipUnless(sys.platform == "darwin", "macOS only")
class Live(unittest.TestCase):
    def test_once_stdout_privacy_and_math(self):
        with tempfile.TemporaryDirectory() as d:
            out = subprocess.run([sys.executable, "-I", SAMPLER, "--once", "--stdout"], capture_output=True,
                                 text=True, env={**os.environ, "CLAUDE_MONITOR_LOG_DIR": d}, check=True).stdout
        rec = json.loads(out)
        s = rec["sys"]
        self.assertGreater(s["used_gb"], 0)
        self.assertLessEqual(s["used_gb"] + s["free_gb"], s["total_gb"] * 1.05)
        self.assertIn(s["pressure"], ("normal", "warn", "critical", "unknown"))
        self.assertIsNotNone(s["cpu_used"])
        for name in rec["groups"]:
            self.assertNotIn("/", name)
            self.assertNotIn(" -", name)
        for p in rec["top"]:
            self.assertEqual(set(p), {"pid", "mb", "cpu", "name"})
            self.assertNotIn("/", p["name"])

    def test_report_rejects_bad_since(self):
        r = subprocess.run([sys.executable, "-I", SAMPLER, "report", "--since", "2x"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
