# Thin aliases for ./sb (Windows: use .\sb.ps1)
.PHONY: up down reset logs dev test score trace submit doctor
up: ; ./sb up
down: ; ./sb down
reset: ; ./sb reset
logs: ; ./sb logs
dev: ; ./sb dev
test: ; ./sb test
score: ; ./sb score $(if $(TRACK),--track $(TRACK)) $(if $(SEED),--seed $(SEED))
trace: ; ./sb trace
submit: ; ./sb submit
doctor: ; ./sb doctor
