"""Allow ``python -m autodev`` to use the installed CLI."""

from autodev.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
