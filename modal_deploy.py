"""
Modal 24/7 Cloud Autopilot for Bahn Express "Spread" (Runs With Laptop Closed!)
===============================================================================
Deploys three automated cloud jobs on Modal (with persistent strategy storage) so
your team competes, self-tunes, plays every Ranking Round, and plays the Saturday
Test Finals + Sunday 08:00 AM Final even when your laptop is closed and asleep:

  1. `scheduled_ranking_and_training` (Every 60 minutes):
     - Plays any newly opened Official Level 8 Ranking Round (5 worlds).
     - Runs a practice self-tuning sweep with Gemini 4 Hydrogen and persists the
       Champion Strategy to a Modal Volume (`/data`).
  2. `scheduled_final_watchdog` (Every 15 minutes on Saturday & Sunday):
     - Checks `GET /v1/final` for the Saturday 14:00 & 20:00 Test Finals and the
       Sunday 08:00 AM Final (which opens at 07:30 Helsinki time) and plays the
       entire live stream automatically.

Quick Setup (3 commands):
  pip install modal
  modal setup
  modal secret create spread-secrets \
    SPREAD_URL=https://spread.bahnexpress.com \
    SPREAD_KEY=spread-qhav5-az4ku-m6nku-ehkmz \
    GEMINI_API_KEY=<your-gemini-api-key>
  modal deploy modal_deploy.py
"""

import os
import subprocess
import modal

app = modal.App("bahn-spread-quant-bot")
data_volume = modal.Volume.from_name("spread-strategy-data", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ca-certificates", "gnupg")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
    )
    .add_local_dir(
        ".",
        remote_path="/app",
        ignore=["node_modules", ".git", ".env", ".env.*", "reveal-*", "__pycache__"],
        copy=True,
    )
    .run_commands("cd /app && npm install")
)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("spread-secrets", required_keys=["SPREAD_URL", "SPREAD_KEY"])],
    volumes={"/app/data": data_volume},
    schedule=modal.Period(minutes=60),
    timeout=1800,
)
def scheduled_ranking_and_training():
    """
    Runs every hour in the cloud (even when your laptop is closed):
    1. Plays all 5 worlds if a new Ranking Round has opened.
    2. Runs a self-tuning practice round and commits updated strategy to the Modal Volume.
    """
    os.chdir("/app")
    print("[Modal Cloud Cron] Checking Official Level 8 Ranking Board...")
    subprocess.run(["node", "auto-trainer.ts", "--board-round"], check=False)
    print("[Modal Cloud Cron] Running self-tuning practice sweep...")
    subprocess.run(["node", "auto-trainer.ts", "--sweep", "2"], check=False)
    data_volume.commit()


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("spread-secrets", required_keys=["SPREAD_URL", "SPREAD_KEY"])],
    volumes={"/app/data": data_volume},
    timeout=3600,
)
def play_sunday_final():
    """
    Connects to `GET /v1/final` and plays the live Saturday Test Finals (14:00 / 20:00)
    or Sunday 08:00 AM Final from the cloud with automatic server-restart recovery.
    """
    os.chdir("/app")
    cmd = ["node", "bot.ts", "--final"]
    print(f"[Modal Final Runner] Launching: {' '.join(cmd)}")
    proc = subprocess.run(cmd, check=True)
    data_volume.commit()
    return {"exit_code": proc.returncode}


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("spread-secrets", required_keys=["SPREAD_URL", "SPREAD_KEY"])],
    volumes={"/app/data": data_volume},
    timeout=900,
)
def run_cloud_practice(level: int = 8, seed: str = "spread-1", board: bool = False):
    os.chdir("/app")
    cmd = ["node", "bot.ts", "--level", str(level)]
    if board:
        cmd.append("--board")
    elif seed:
        cmd.extend(["--seed", seed])
    subprocess.run(cmd, check=True)
    data_volume.commit()


@app.local_entrypoint()
def main(level: int = 8, seed: str = "spread-1", board: bool = False, final: bool = False):
    if final:
        play_sunday_final.remote()
    else:
        run_cloud_practice.remote(level=level, seed=seed, board=board)
