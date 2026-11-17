CREATE TABLE "clips" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"scene_index" integer NOT NULL,
	"audio" "bytea" NOT NULL,
	"mime" text DEFAULT 'audio/mpeg' NOT NULL,
	"bytes" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"words" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clips_message_scene_uq" UNIQUE("message_id","scene_index")
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"topic" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"script" jsonb,
	"suggestions" jsonb,
	"voice_mode" text DEFAULT 'eleven' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_lesson_seq_uq" UNIQUE("lesson_id","seq")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lessons_owner_created_idx" ON "lessons" USING btree ("owner_id","created_at");