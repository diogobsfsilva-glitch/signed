-- Grupo 1: novos tipos de campo.
--   name, email, signed_date  preenchidos automaticamente (o signatário não os altera)
--   attachment                anexo carregado pelo signatário (PDF ou imagem)
-- (Ficheiro separado: os novos valores de um enum só podem ser usados depois do commit.)
alter type public.field_type add value if not exists 'name';
alter type public.field_type add value if not exists 'email';
alter type public.field_type add value if not exists 'signed_date';
alter type public.field_type add value if not exists 'attachment';
