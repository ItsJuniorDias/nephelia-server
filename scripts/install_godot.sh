#!/usr/bin/env bash
# Baixa o Godot oficial para Linux (o mesmo da versão do jogo) em ./bin/godot. No Render roda
# sozinho no build (`npm install`/`npm ci` chamam o postinstall do package.json). No Mac não precisa:
# lá o matchmaker usa o Godot que já está instalado (--godotBin).
set -euo pipefail

# `--only-on-render`: roda sozinho no `npm install` (postinstall), mas só no Render (RENDER=true).
if [ "${1:-}" = "--only-on-render" ] && [ "${RENDER:-}" != "true" ]; then
	exit 0
fi

VERSION="${GODOT_VERSION:-4.7.2-stable}"
case "$(uname -m)" in
	x86_64 | amd64) ARCH="x86_64" ;;
	aarch64 | arm64) ARCH="arm64" ;;
	*) echo "arquitetura não suportada: $(uname -m)" >&2; exit 1 ;;
esac
NAME="Godot_v${VERSION}_linux.${ARCH}"
URL="https://github.com/godotengine/godot/releases/download/${VERSION}/${NAME}.zip"

cd "$(dirname "$0")/.."
if [ -x bin/godot ] && bin/godot --version 2>/dev/null | grep -q "${VERSION%-stable}"; then
	echo "Godot ${VERSION} já está em bin/godot"
	exit 0
fi
mkdir -p bin
echo "baixando ${URL}"
curl -fsSL -o bin/godot.zip "${URL}"
if command -v unzip >/dev/null 2>&1; then
	unzip -o -q bin/godot.zip -d bin
else
	python3 -m zipfile -e bin/godot.zip bin
fi
mv "bin/${NAME}" bin/godot
chmod +x bin/godot
rm bin/godot.zip
bin/godot --version
if [ ! -f game/nephelia_server.pck ]; then
	echo "AVISO: falta game/nephelia_server.pck (exportado do jogo, preset Linux Server)" >&2
fi
