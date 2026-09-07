"""Historical user reproduction: an uploaded file must preserve its final CR bytes."""
import io
from werkzeug.wrappers import Request

for count in (1, 2):
    expected = b'\0' * 65535 + b'\r' * count
    with Request.from_values(data={'upload': (io.BytesIO(expected), 'file.bin')}, method='POST') as request:
        actual = request.files['upload'].read()
    print(f'trailing CR count={count}, expected={len(expected)}, actual={len(actual)}, exact={actual == expected}')
    assert actual == expected
