"""Host-only feasibility patch; never mount this file in a model workspace."""
from pathlib import Path
import sys

path = Path(sys.argv[1]) / "src/werkzeug/sansio/multipart.py"
source = path.read_text()
old = 'complete_boundary_index = len(data) - len(b"\\r\\n--" + self.boundary)'
assert old in source
# A complete marker still needs its suffix (closing -- or a line break).
# Keep the leading CRLF while those final bytes arrive in later fragments.
path.write_text(source.replace(old, old + ' - 4'))
