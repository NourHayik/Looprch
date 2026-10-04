#!/usr/bin/env python3
import sys
from specctl import main
if __name__ == "__main__":
    sys.argv.insert(1, "validate")
    try: main()
    except Exception as e:
        import json
        print(json.dumps({"ok":False,"error":str(e)}),file=sys.stderr);sys.exit(2)
