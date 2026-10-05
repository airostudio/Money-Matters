ALTER TABLE "pay_runs" ADD COLUMN "wages_expense_account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "superannuation_expense_account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "payg_withholding_payable_account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "superannuation_payable_account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "net_wages_payable_account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_wages_expense_account_id_accounts_id_fk" FOREIGN KEY ("wages_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_superannuation_expense_account_id_accounts_id_fk" FOREIGN KEY ("superannuation_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_payg_withholding_payable_account_id_accounts_id_fk" FOREIGN KEY ("payg_withholding_payable_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_superannuation_payable_account_id_accounts_id_fk" FOREIGN KEY ("superannuation_payable_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_net_wages_payable_account_id_accounts_id_fk" FOREIGN KEY ("net_wages_payable_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;