import subprocess
from pipeline import ROOT


def serve():
    subprocess.run(["node", "dev-server.mjs"], cwd=ROOT.parent / "vue-version" / "worker", check=True)
