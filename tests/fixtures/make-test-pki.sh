#!/usr/bin/env bash
# Gera uma PKI de TESTE que imita a hierarquia do Cartão de Cidadão (nomes iguais, chaves falsas).
# Só para testes automáticos. Uso: bash tests/fixtures/make-test-pki.sh
set -euo pipefail
cd "$(dirname "$0")"
rm -rf pki && mkdir pki && cd pki

cat > ext.cnf <<'CNF'
[ca]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[sign_leaf]
basicConstraints = critical, CA:false
keyUsage = critical, nonRepudiation
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[auth_leaf]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[seal]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, nonRepudiation
subjectKeyIdentifier = hash
CNF

key() { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$1.key" 2>/dev/null; }
selfsigned() { key "$1"; openssl req -new -x509 -utf8 -key "$1.key" -subj "$2" -days 3650 -sha256 -extensions ca -config ext.cnf -out "$1.pem"; }
issue() { # nome subj emissor extensão
  key "$1"
  openssl req -new -utf8 -key "$1.key" -subj "$2" -out "$1.csr" -config ext.cnf
  openssl x509 -req -in "$1.csr" -CA "$3.pem" -CAkey "$3.key" -CAcreateserial -days 1825 -sha256 \
    -extfile ext.cnf -extensions "$4" -out "$1.pem" 2>/dev/null
}

selfsigned root "/C=PT/O=Sistema de Certificação Eletrónica do Estado/CN=ECRaizEstado 002"
issue cc008 "/C=PT/O=SCEE - Sistema de Certificação Electrónica do Estado/OU=ECEstado/CN=Cartão de Cidadão 008" root ca
issue sigca "/C=PT/O=Instituto dos Registos e do Notariado I.P./OU=Cartão de Cidadão/OU=subECEstado/CN=EC de Assinatura Digital Qualificada do Cartão de Cidadão 0020" cc008 ca
issue authca "/C=PT/O=Instituto dos Registos e do Notariado I.P./OU=Cartão de Cidadão/OU=subECEstado/CN=EC de Autenticação do Cartão de Cidadão 0020" cc008 ca
issue maria "/C=PT/OU=Cidadão Português/OU=Assinatura Qualificada do Cidadão/SN=Fernandes Silva/GN=Maria/serialNumber=BI123456780/CN=Maria Fernandes Silva" sigca sign_leaf
issue maria_auth "/C=PT/OU=Cidadão Português/OU=Autenticação do Cidadão/SN=Fernandes Silva/GN=Maria/serialNumber=BI123456780/CN=Maria Fernandes Silva" authca auth_leaf
issue joao "/C=PT/OU=Cidadão Português/OU=Assinatura Qualificada do Cidadão/SN=Costa/GN=João/serialNumber=BI987654321/CN=João Pedro Costa" sigca sign_leaf
# Atacante: hierarquia com os mesmos nomes mas outra raiz
selfsigned rogue_root "/C=PT/O=Sistema de Certificação Eletrónica do Estado/CN=ECRaizEstado 002"
issue rogue_cc "/C=PT/O=SCEE/OU=ECEstado/CN=Cartão de Cidadão 008" rogue_root ca
issue rogue_sigca "/C=PT/O=IRN/CN=EC de Assinatura Digital Qualificada do Cartão de Cidadão 0020" rogue_cc ca
issue rogue "/C=PT/SN=Fernandes Silva/GN=Maria/serialNumber=BI123456780/CN=Maria Fernandes Silva" rogue_sigca sign_leaf
# Selo da plataforma (autoassinado)
key seal
openssl req -new -x509 -utf8 -key seal.key -subj "/C=PT/O=Altis Hotels/CN=Signed - Selo eletrónico (TESTE)" -days 3650 -sha256 -extensions seal -config ext.cnf -out seal.pem
for k in *.key; do openssl pkcs8 -topk8 -nocrypt -in "$k" -out "${k%.key}.p8"; done
rm -f *.csr *.srl *.key ext.cnf
echo "PKI de teste criada em $(pwd)"
