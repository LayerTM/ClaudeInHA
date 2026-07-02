# Make the Claude CLI and add-on tools available in every shell tab, so
# `claude`, `claude update`, and `update-claude` work exactly as on a desktop.
export HOME=/data/home
case ":${PATH}:" in
    *":/data/home/.local/bin:"*) ;;
    *) export PATH="/data/home/.local/bin:${PATH}" ;;
esac
export USE_BUILTIN_RIPGREP=0
