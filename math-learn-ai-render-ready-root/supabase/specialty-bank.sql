-- MathSpark: enable the separate Specialty Bank on an existing installation.
-- Run once in Supabase Dashboard > SQL Editor AFTER exam-bank.sql.
-- Existing rows become regular exam-bank items because bank_type defaults to 'exam'.

alter table public.learning_exams
  add column if not exists bank_type text not null default 'exam';

alter table public.learning_exams
  add column if not exists ai_request text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'learning_exams_bank_type_check'
      and conrelid = 'public.learning_exams'::regclass
  ) then
    alter table public.learning_exams
      add constraint learning_exams_bank_type_check check (bank_type in ('exam','specialty'));
  end if;
end $$;

create index if not exists learning_exams_bank_type_status_created_idx
  on public.learning_exams(bank_type, status, created_at desc);
