# PLAN-0632 Agent payload entry point (PyInstaller).
# Copied verbatim (import chain and call shape) from the M1-T1 spike entry
# (A03-xihe/.tmp/plan-0632-t1/entry.py), which is byte-identical in intent to the M0 spike entry.
# Keep the chain identical: cold-start measurements (D32-05, p50 4.00 s onedir) stay comparable,
# and `xihe_agent.main` must stay imported as a named hidden import in the generated spec.
import uvicorn
from xihe_agent.main import app, AGENT_HOST, AGENT_PORT
uvicorn.run(app, host=AGENT_HOST, port=AGENT_PORT)
