CREATE TABLE "template_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"company" text NOT NULL,
	"phrase_key" text NOT NULL,
	"phrase" text NOT NULL,
	"question" text NOT NULL,
	"query_hash" text NOT NULL,
	"query" text NOT NULL,
	"params" jsonb NOT NULL,
	"columns" jsonb NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "query_templates" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "query_templates" ADD COLUMN "company" text;--> statement-breakpoint
ALTER TABLE "query_templates" ADD COLUMN "source" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "query_templates" ADD COLUMN "hits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "query_templates" ADD COLUMN "rejected" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "template_candidates" ADD CONSTRAINT "template_candidates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "template_candidates_key" ON "template_candidates" USING btree ("account_id","company","phrase_key","query_hash");--> statement-breakpoint
ALTER TABLE "query_templates" ADD CONSTRAINT "query_templates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;