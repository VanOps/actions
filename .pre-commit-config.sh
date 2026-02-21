#!/bin/bash

# Este script configura el entorno para ejecutar pre-commit con las herramientas necesarias.

# 1. Activa un environment virtual (opcional pero recomendado)
pyenv install 3.12.0
pyenv virtualenv 3.12.0 pre-commit-env
pyenv activate pre-commit-env

# 2. Instala las dependencias necesarias
pip install pre-commit semgrep trufflehog pkg_resources
pip install "setuptools<81"
pip install --upgrade semgrep
pip install --force-reinstall "setuptools==70.1.1" "packaging"
pip install --force-reinstall semgrep==1.70.0
# 3. Reinstala
pre-commit autoupdate
pre-commit install --install-hooks

# 4. Test
pre-commit run --all-files