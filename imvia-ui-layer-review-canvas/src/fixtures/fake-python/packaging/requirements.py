import re


class _Specifier:
    def __init__(self, text):
        self.text = text

    def __contains__(self, _version):
        return True

    def __str__(self):
        return self.text


class Requirement:
    def __init__(self, text):
        match = re.match(r"([A-Za-z0-9_.-]+)(.*)", text)
        if not match:
            raise ValueError(f"invalid fake requirement: {text}")
        self.name = match.group(1)
        self.specifier = _Specifier(match.group(2))
        self.marker = None
