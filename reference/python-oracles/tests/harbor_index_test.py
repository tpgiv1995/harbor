import importlib.util
import io
import pathlib
import unittest
from contextlib import redirect_stdout
from datetime import datetime
from unittest import mock


INDEXER_PATH = pathlib.Path(__file__).resolve().parents[1] / "harbor-index.py"
SPEC = importlib.util.spec_from_file_location("harbor_index", INDEXER_PATH)
INDEXER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INDEXER)


class EmitCompatibilityTest(unittest.TestCase):
    def setUp(self):
        self.entry = {
            "id": "11111111-1111-1111-1111-111111111111",
            "mt": 1,
            "cwd": "/home/you/dev/harbor",
            "title": "Picker title",
            "first_prompt": "Full prompt",
        }

    def emit(self, args):
        output = io.StringIO()
        with mock.patch.object(INDEXER, "refresh_index", return_value={"/tmp/session.jsonl": self.entry}), \
             mock.patch.object(INDEXER, "entry_last_dt", return_value=datetime(2026, 7, 17, 1, 30)), \
             redirect_stdout(output):
            INDEXER.cmd_emit(args)
        return output.getvalue()

    def test_emit_without_with_cwd_preserves_picker_tsv_byte_for_byte(self):
        self.assertEqual(
            self.emit(["--all"]),
            "11111111-1111-1111-1111-111111111111\t2026-07-17 01:30\tharbor                    \tPicker title\n",
        )

    def test_emit_with_cwd_appends_cwd_after_first_prompt(self):
        self.assertEqual(
            self.emit(["--all", "--with-first-prompt", "--with-cwd"]),
            "11111111-1111-1111-1111-111111111111\t2026-07-17 01:30\tharbor\tPicker title\tFull prompt\t/home/you/dev/harbor\n",
        )


if __name__ == "__main__":
    unittest.main()
