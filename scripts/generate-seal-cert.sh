#!/usr/bin/env bash
# Gera o certificado do selo eletrónico da plataforma (autoassinado, gratuito).
# O selo prova que o PDF final não foi alterado depois de concluído.
# Uso: bash scripts/generate-seal-cert.sh  ->  cria seal-cert.pem e seal-key.pem (NÃO fazer commit)
set -euo pipefail
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 -utf8 \
  -subj "/C=PT/O=Altis Hotels/CN=Signed - Selo eletrónico Altis Hotels" \
  -addext "keyUsage=critical,digitalSignature,nonRepudiation" \
  -keyout seal-key.tmp -out seal-cert.pem
openssl pkcs8 -topk8 -nocrypt -in seal-key.tmp -out seal-key.pem
rm -f seal-key.tmp
chmod 600 seal-key.pem
echo "Criados seal-cert.pem e seal-key.pem. Carregue-os como segredos:"
echo "  npx supabase secrets set SEAL_CERT_PEM=\"\$(cat seal-cert.pem)\" SEAL_KEY_PEM=\"\$(cat seal-key.pem)\""
echo "Depois guarde a chave num local seguro e apague-a deste computador."
