CREATE TABLE "remote_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid NOT NULL,
	"device_id" uuid,
	"link_id" uuid,
	"telegram_user_id" text,
	"command_id" uuid,
	"type" text NOT NULL,
	"class" text,
	"event" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "remote_blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"command_id" uuid,
	"direction" text NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"company_inn" text NOT NULL,
	"type" text NOT NULL,
	"class" text NOT NULL,
	"payload" text NOT NULL,
	"proposal_hash" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" text,
	"error" text,
	"progress" text
);
--> statement-breakpoint
CREATE TABLE "remote_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"app_version" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"companies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"telegram_user_id" text NOT NULL,
	"username" text,
	"ceiling" text DEFAULT 'prepare' NOT NULL,
	"active_company_inn" text,
	"language" text DEFAULT 'ru' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "telegram_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"account_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"ceiling" text DEFAULT 'prepare' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remote_blobs" ADD CONSTRAINT "remote_blobs_device_id_remote_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."remote_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_blobs" ADD CONSTRAINT "remote_blobs_command_id_remote_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."remote_commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_commands" ADD CONSTRAINT "remote_commands_device_id_remote_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."remote_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_commands" ADD CONSTRAINT "remote_commands_link_id_telegram_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."telegram_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_devices" ADD CONSTRAINT "remote_devices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_device_id_remote_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."remote_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_pairings" ADD CONSTRAINT "telegram_pairings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_pairings" ADD CONSTRAINT "telegram_pairings_device_id_remote_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."remote_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remote_audit_account_idx" ON "remote_audit" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "remote_blobs_command_idx" ON "remote_blobs" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "remote_blobs_expires_idx" ON "remote_blobs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "remote_commands_device_state_idx" ON "remote_commands" USING btree ("device_id","state","created_at");--> statement-breakpoint
CREATE INDEX "remote_commands_link_idx" ON "remote_commands" USING btree ("link_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_devices_token_key" ON "remote_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "remote_devices_account_idx" ON "remote_devices" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "telegram_links_user_idx" ON "telegram_links" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_pairings_code_key" ON "telegram_pairings" USING btree ("code_hash");