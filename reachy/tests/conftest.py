import sys
from pathlib import Path

# Make the package importable without installing it (and without the Reachy Mini SDK:
# the tests only cover the pure modules, never sidekiqq_reachy.main / expressions).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from fakebrain import FakeBrain  # noqa: E402


@pytest.fixture
def brain():
    b = FakeBrain()
    yield b
    b.close()
