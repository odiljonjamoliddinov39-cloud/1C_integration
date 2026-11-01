CREATE TABLE "crm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"by_admin_id" uuid,
	"result" text NOT NULL,
	"duration_sec" integer,
	"note" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"file_name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_created" integer DEFAULT 0 NOT NULL,
	"rows_updated" integer DEFAULT 0 NOT NULL,
	"rows_failed" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"columns" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"phone_key" text NOT NULL,
	"source" text,
	"company" text,
	"owner_id" uuid,
	"created_by" uuid,
	"last_contact_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"author_id" uuid,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid NOT NULL,
	"by_admin_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"is_won" boolean DEFAULT false NOT NULL,
	"is_lost" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "telegram_id" text;--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_calls" ADD CONSTRAINT "crm_calls_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_calls" ADD CONSTRAINT "crm_calls_by_admin_id_admins_id_fk" FOREIGN KEY ("by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_import_jobs" ADD CONSTRAINT "crm_import_jobs_created_by_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_pipeline_id_crm_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."crm_pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_stage_id_crm_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_owner_id_admins_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_created_by_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_author_id_admins_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stage_history" ADD CONSTRAINT "crm_stage_history_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stage_history" ADD CONSTRAINT "crm_stage_history_from_stage_id_crm_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stage_history" ADD CONSTRAINT "crm_stage_history_to_stage_id_crm_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stage_history" ADD CONSTRAINT "crm_stage_history_by_admin_id_admins_id_fk" FOREIGN KEY ("by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stages" ADD CONSTRAINT "crm_stages_pipeline_id_crm_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."crm_pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_calls_lead_idx" ON "crm_calls" USING btree ("lead_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_leads_phone_key" ON "crm_leads" USING btree ("phone_key");--> statement-breakpoint
CREATE INDEX "crm_leads_stage_idx" ON "crm_leads" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "crm_leads_owner_idx" ON "crm_leads" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "crm_leads_created_idx" ON "crm_leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "crm_notes_lead_idx" ON "crm_notes" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "crm_stage_history_lead_idx" ON "crm_stage_history" USING btree ("lead_id","at");--> statement-breakpoint
CREATE INDEX "crm_stages_pipeline_idx" ON "crm_stages" USING btree ("pipeline_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "admins_telegram_id_key" ON "admins" USING btree ("telegram_id") WHERE "admins"."telegram_id" is not null;