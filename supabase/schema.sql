-- Reader: database schema for Supabase. Run this once in the SQL editor of
-- your Supabase project (Dashboard -> SQL Editor -> New query -> paste -> Run).
-- Safe to run again; every statement is idempotent.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables
create table if not exists public.documents (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title             text not null,
  original_filename text not null default '',
  file_path         text,                     -- storage object path: <user id>/<document id>.pdf
  total_pages       integer not null default 1,
  text_length       integer not null default 0,
  chapter_method    text not null default 'none',
  chapters          jsonb not null default '[]'::jsonb,   -- Chapter[] (id, title, startPage, endPage, startCharacterIndex, endCharacterIndex)
  pages             jsonb not null default '[]'::jsonb,   -- page map (pageNumber, startCharIndex, endCharIndex)
  uploaded_at       timestamptz not null default now(),
  last_opened_at    timestamptz not null default now()
);
create index if not exists documents_user_opened on public.documents (user_id, last_opened_at desc);

create table if not exists public.document_texts (
  document_id uuid primary key references public.documents(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text        text not null
);

create table if not exists public.reading_progress (
  document_id     uuid primary key references public.documents(id) on delete cascade,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  page_number     integer not null default 1,
  character_index integer not null default 0,
  sentence_index  integer,
  chapter_id      text,
  percentage      numeric(5,1) not null default 0,
  completed       boolean not null default false,
  saved_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------- row-level security
alter table public.documents        enable row level security;
alter table public.document_texts   enable row level security;
alter table public.reading_progress enable row level security;

drop policy if exists "documents are private" on public.documents;
create policy "documents are private" on public.documents
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "texts are private" on public.document_texts;
create policy "texts are private" on public.document_texts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "progress is private" on public.reading_progress;
create policy "progress is private" on public.reading_progress
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------- atomic create
create or replace function public.create_document(
  p_id uuid, p_title text, p_original_filename text, p_file_path text,
  p_total_pages integer, p_text_length integer, p_chapter_method text,
  p_chapters jsonb, p_pages jsonb, p_text text, p_chapter_id text
) returns public.documents
language plpgsql security invoker as $$
declare d public.documents;
begin
  insert into public.documents (id, user_id, title, original_filename, file_path, total_pages, text_length, chapter_method, chapters, pages)
  values (p_id, auth.uid(), p_title, coalesce(p_original_filename, ''), p_file_path, p_total_pages, p_text_length, coalesce(p_chapter_method, 'none'), coalesce(p_chapters, '[]'::jsonb), coalesce(p_pages, '[]'::jsonb))
  returning * into d;
  insert into public.document_texts (document_id, user_id, text) values (p_id, auth.uid(), p_text);
  insert into public.reading_progress (document_id, user_id, chapter_id) values (p_id, auth.uid(), p_chapter_id);
  return d;
end $$;

-- ---------------------------------------------------------------- PDF storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdfs', 'pdfs', false, 52428800, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 52428800, allowed_mime_types = array['application/pdf'];

drop policy if exists "pdfs are private" on storage.objects;
create policy "pdfs are private" on storage.objects
  for all using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
