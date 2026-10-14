extends Node

var _failures := PackedStringArray()
var _checks := 0
var _i18n: Node
var _tuning: Node
var _save_store: Node
var _audio: Node
var _saved_user_files: Dictionary = {}


func _ready() -> void:
	call_deferred("_run")


func _run() -> void:
	# macOS does not redirect Godot user:// with XDG_DATA_HOME. Preserve files
	# explicitly and start from an empty fixture instead of the player's top ten.
	for path: String in [SaveStore.SAVE_PATH]:
		_saved_user_files[path] = FileAccess.get_file_as_bytes(path) if FileAccess.file_exists(path) else null
	_i18n = get_tree().root.get_node_or_null("I18n")
	_tuning = get_tree().root.get_node_or_null("TuningStore")
	_save_store = get_tree().root.get_node_or_null("SaveStore")
	_audio = get_tree().root.get_node_or_null("AudioDirector")
	_save_store.set("_data", _save_store.call("_default_data"))
	for item: Array in [
		[_i18n, "I18n"], [_tuning, "TuningStore"],
		[_save_store, "SaveStore"], [_audio, "AudioDirector"],
	]:
		_check(item[0] != null, "%s autoload must exist" % item[1])
	# First-launch language follows the machine locale; pin English so checks are machine-independent.
	_i18n.call("set_locale", "en")
	_test_locale_detection()
	_test_stage_catalog()
	_test_localization_catalogs()
	_test_tuning_schema_and_integrity()
	_test_score_service()
	_test_local_leaderboard()
	_test_audio_architecture()
	_test_assets()
	_test_font_glyph_coverage()
	await _test_effect_pool()
	await _test_runtime_scene()
	_audio.call("release_streams")
	await get_tree().process_frame
	_restore_user_files()
	if _failures.is_empty():
		print("[game-generic-tests] PASS: %d checks" % _checks)
		get_tree().quit(0)
		return
	for failure: String in _failures:
		push_error("[game-generic-tests] " + failure)
	print("[game-generic-tests] FAIL: %d failures across %d checks" % [_failures.size(), _checks])
	get_tree().quit(1)


func _restore_user_files() -> void:
	for path: String in _saved_user_files:
		var original: Variant = _saved_user_files[path]
		if original == null:
			if FileAccess.file_exists(path):
				_check(DirAccess.remove_absolute(ProjectSettings.globalize_path(path)) == OK, "test fixture must be removed: " + path)
		else:
			var file := FileAccess.open(path, FileAccess.WRITE)
			_check(file != null, "original user file must be writable: " + path)
			if file != null:
				file.store_buffer(original)
				file.close()
				_check(FileAccess.get_file_as_bytes(path) == original, "original user file must be restored byte-for-byte: " + path)


func _test_locale_detection() -> void:
	# Pure functions only: results must not depend on this machine's OS locale.
	var i18n_script: Script = load("res://autoload/i18n.gd")
	for case: Array in [
		["zh_CN", "zh-CN"], ["zh-CN", "zh-CN"], ["zh-Hans-CN", "zh-CN"], ["zh_TW", "zh-CN"], ["ZH", "zh-CN"],
		["en_US", "en"], ["en", "en"], ["fr_FR", "en"], ["ja_JP", "en"], ["", "en"],
	]:
		_check(i18n_script.call("detect_locale", case[0]) == case[1], "OS locale %s must map to %s" % case)
	_check(i18n_script.call("resolve_locale", "", "zh_CN") == "zh-CN", "first launch follows a Chinese browser")
	_check(i18n_script.call("resolve_locale", "", "de_DE") == "en", "first launch defaults other languages to English")
	_check(i18n_script.call("resolve_locale", "en", "zh_CN") == "en", "a saved English choice beats a Chinese browser")
	_check(i18n_script.call("resolve_locale", "zh-CN", "en_US") == "zh-CN", "a saved Chinese choice beats an English browser")
	_check(i18n_script.call("resolve_locale", "xx", "en_US") == "en", "unknown saved values fall back to detection")


func _test_stage_catalog() -> void:
	_check(StageCatalog.count() == 2, "catalog must expose two stages")
	var stage_maximum := 0
	for index: int in StageCatalog.count():
		var stage := StageCatalog.get_stage(index)
		var errors := StageCatalog.validate_stage(stage)
		_check(errors.is_empty(), "stage %d validation failed: %s" % [index + 1, ", ".join(errors)])
		_check(StageCatalog.dimensions(stage) == Vector2i(21, 17), "stage %d must retain authored dimensions" % (index + 1))
		var symbols := ""
		for row: String in stage.get("rows", []):
			symbols += row
		for symbol: String in ["s", "t", "m"]:
			_check(symbols.count(symbol) == 1, "stage %d needs one '%s' power-up" % [index + 1, symbol])
		_check(symbols.count("o") >= 1, "stage %d needs a Overdrive" % (index + 1))
		stage_maximum += RunScoreService.authored_collectible_maximum(stage)
	_check(stage_maximum > 2000, "authored two-stage score maximum must be meaningful")


func _test_localization_catalogs() -> void:
	var english: Array = _i18n.call("catalog_keys", "en")
	var chinese: Array = _i18n.call("catalog_keys", "zh-CN")
	english.sort()
	chinese.sort()
	_check(english == chinese, "EN and zh-CN catalogs must have identical keys")
	_check(english.size() >= 120, "catalogs must cover the full template UI")
	_i18n.call("set_locale", "en")
	_check(str(_i18n.call("t", "app.title")) == "Generic Game Template", "t() must resolve the English title")
	_i18n.call("set_locale", "zh-CN")
	_check(str(_i18n.call("t", "menu.play")) == "开始游戏", "Chinese locale must resolve")
	_check("调校" in str(_i18n.call("t", "tuning.quick_tooltip")), "Chinese tuning guidance must resolve")
	_i18n.call("set_locale", "en")


func _test_tuning_schema_and_integrity() -> void:
	_check(int(_tuning.get("schema_version")) == 3, "tuning schema version must be 3")
	var settings: Array = _tuning.call("get_settings")
	_check(settings.size() == 20, "the runtime surface must expose 20 game controls")
	var categories: Array = _tuning.call("get_categories")
	for category: String in ["UI", "Gameplay", "Audio", "Player", "Enemies", "Environment"]:
		_check(category in categories, "missing tuning category: " + category)
	var ids := {}
	for setting: Dictionary in settings:
		var id := str(setting.get("id", ""))
		_check(not id.is_empty() and not ids.has(id), "tuning IDs must be unique and non-empty")
		ids[id] = true
		for field: String in ["category", "type", "default", "unit_key", "apply_mode", "integrity", "label_key", "description_key", "tags"]:
			_check(setting.has(field), "%s must declare %s" % [id, field])
		_check(str(setting.apply_mode) in ["LIVE", "NEXT_ACTION", "NEXT_STAGE", "NEXT_RUN"], id + " has invalid apply mode")
		_check(str(setting.integrity) in ["COSMETIC", "GAMEPLAY"], id + " has invalid integrity class")
	_tuning.call("end_run")
	_tuning.call("reset_defaults")
	_check(not bool(_tuning.call("set_value", "player.move.max_speed", 9999.0)), "out-of-range tuning must be rejected")
	_check(is_equal_approx(float(_tuning.call("get_value", "player.move.max_speed")), 170.0), "a rejected value must not mutate active state")
	_check(bool(_tuning.call("set_value", "player.lives", 5.0)), "a valid deferred value must be accepted")
	_check(is_equal_approx(float(_tuning.call("get_requested_value", "player.lives")), 5.0), "requested state must update")
	_check(is_equal_approx(float(_tuning.call("get_active_value", "player.lives")), 3.0), "NEXT_RUN state must remain deferred")
	_check(int(_tuning.call("pending_count")) == 1, "pending value count must be observable")
	_tuning.call("begin_run", false)
	_check(is_equal_approx(float(_tuning.call("get_active_value", "player.lives")), 5.0), "NEXT_RUN state must apply at run boundary")
	_check(not bool(_tuning.call("is_ranked_eligible")), "non-default gameplay tuning must mark the run unranked")
	_tuning.call("reset_setting", "player.lives")
	_check(not bool(_tuning.call("is_ranked_eligible")), "ranked ineligibility must remain sticky after reset")
	_tuning.call("end_run")
	_tuning.call("reset_defaults")
	_tuning.call("begin_run", false)
	_check(bool(_tuning.call("is_ranked_eligible")), "a fresh default run must be ranked")
	_tuning.call("set_value", "environment.filter.intensity", 0.5)
	_check(bool(_tuning.call("is_ranked_eligible")), "cosmetic tuning must preserve ranked eligibility")
	_tuning.call("set_value", "player.move.max_speed", 180.0)
	_check(not bool(_tuning.call("is_ranked_eligible")), "live gameplay tuning must revoke ranked eligibility")
	var before: Dictionary = _tuning.call("get_requested_values")
	_check(not bool(_tuning.call("set_values", {"audio.music.volume_db": -12.0, "player.lives": 99.0})), "transactional updates must reject an invalid bundle")
	_check((_tuning.call("get_requested_values") as Dictionary) == before, "invalid transactional updates must be atomic")
	_tuning.call("end_run")
	_tuning.call("reset_defaults")
	_check(str(_tuning.call("configuration_marker")).begins_with("cfg-"), "configuration marker must be stable and explicit")


func _test_score_service() -> void:
	var scorer := RunScoreService.new()
	scorer.begin()
	_check(scorer.award("energy") == 10, "energy score must be named and deterministic")
	_check(scorer.award("overdrive") == 60, "Overdrive score must be named and deterministic")
	_check(scorer.award("powerup", 2) == 210, "power-up score multiplication must be deterministic")
	_check(scorer.award("unknown") == 210, "unknown events must not change score")
	var first := scorer.finalize(2, "victory", 12.5, true, "cfg-test")
	var second := scorer.finalize(1, "defeat", 1.0, false, "cfg-other")
	_check(first == second, "run finalization must be idempotent")
	_check(bool(first.ranked_eligible), "eligible non-tutorial result must remain ranked")
	first.score = 0
	_check(int(scorer.get_result().score) == 210, "returned run results must be defensive copies")
	var tutorial_scorer := RunScoreService.new()
	tutorial_scorer.begin(50)
	var tutorial_result := tutorial_scorer.finalize(1, "victory", 2.0, true, "cfg-default", true)
	_check(not bool(tutorial_result.ranked_eligible), "tutorial results must never be globally ranked")


func _test_local_leaderboard() -> void:
	var result := {
		"score": 2400, "stage": 2, "duration": 70.0, "outcome": "victory",
		"configuration_marker": "cfg-default", "ranked_eligible": true, "finalized_at": 1,
	}
	_check(bool(_save_store.call("record_result", "ALPHA", result)), "local result persistence must succeed")
	result.score = 1200
	result.ranked_eligible = false
	_check(bool(_save_store.call("record_result", "BETA", result)), "practice result persistence must succeed")
	var rows: Array = _save_store.call("get_leaderboard")
	_check(rows.size() >= 2, "local standings must retain submitted rows")
	_check(str((rows[0] as Dictionary).get("name")) == "ALPHA", "local standings must sort highest score first")
	_check((rows[0] as Dictionary).has("configuration_marker"), "local rows must retain configuration provenance")
	_save_store.call("_load")
	_check(_save_store.call("get_leaderboard") == rows, "local standings must survive disk reload unchanged")
	var detached: Array = _save_store.call("get_leaderboard")
	detached.clear()
	_check(_save_store.call("get_leaderboard") == rows, "standings callers must not mutate saved rows")


func _test_audio_architecture() -> void:
	var cue_ids: Array = _audio.call("get_cue_ids")
	for cue: String in ["music.title", "music.gameplay", "ui.confirm", "ui.cancel", "player.action", "enemy.impact", "score.reward", "game.pause", "game.victory", "game.defeat"]:
		_check(cue in cue_ids, "missing semantic audio cue: " + cue)
	var capacity: Dictionary = _audio.call("get_voice_capacity")
	_check(int(capacity.music) == 2, "music crossfade requires two voices")
	_check(int(capacity.sfx) == 8, "SFX polyphony must be bounded at eight voices")
	_check(int(capacity.ui) == 2, "UI polyphony must be bounded at two voices")
	for bus_name: String in ["Master", "Music", "SFX", "UI"]:
		_check(AudioServer.get_bus_index(bus_name) >= 0, "missing audio bus: " + bus_name)
	for cue: String in cue_ids:
		_check(not bool(_audio.call("play_music" if cue.begins_with("music.") else "play_cue", cue)), "unassigned cue must be silent: " + cue)
	_check(not bool(_audio.call("register_cue", "ui.confirm", "")), "empty audio path must be safe")
	_check(not bool(_audio.call("register_cue", "ui.confirm", "res://assets/template/audio/missing.ogg")), "missing SFX file must be safe")
	_check(not bool(_audio.call("register_cue", "music.title", "res://assets/template/audio/missing.ogg")), "missing BGM file must be safe")
	_check(not bool(_audio.call("register_cue", "ui.confirm", "res://assets/template/characters/runner.png")), "non-audio resources must be rejected")
	var fixture := AudioStreamWAV.new()
	fixture.format = AudioStreamWAV.FORMAT_8_BITS
	fixture.mix_rate = 8000
	fixture.data = PackedByteArray([128, 128, 128, 128])
	_check(bool(_audio.call("register_stream", "ui.confirm", fixture)), "optional stream must register")
	_audio.call("unlock_audio")
	_check(bool(_audio.call("play_cue", "ui.confirm")), "registered cue must play")
	_check(bool(_audio.call("register_stream", "music.title", fixture)), "optional BGM must register")
	_check(bool(_audio.call("play_music", "music.title")), "registered BGM must play")
	_check(not bool(_audio.call("play_music", "music.gameplay")), "missing music route must stop previous music")
	_check(str(_audio.get("_music_cue")).is_empty(), "silent music route must clear the active route")
	for player in _audio.get("_music_players"):
		_check(player.stream == null and not player.playing, "missing BGM must release old streams")
		_check(player.playback_type == AudioServer.PLAYBACK_TYPE_STREAM, "BGM must use streaming playback")
	_check(not bool(_audio.call("register_stream", "ui.confirm", null)), "null replacement must clear cue")
	_check(not bool(_audio.call("play_cue", "ui.confirm")), "removed SFX must return silence")
	for index: int in 30:
		_audio.call("play_music", "missing.music")
		_audio.call("play_cue", "missing.cue")
		_audio.call("set_game_paused", index % 2 == 0)
	_audio.call("set_game_paused", false)
	_check(_audio.call("get_voice_capacity") == capacity, "silent retries must not create voices")
	_audio.call("release_streams")
	_check(not bool(_audio.call("play_cue", "missing.cue")), "unknown cue must fail safely")


func _test_assets() -> void:
	for path: String in [
		"res://assets/template/environment/backdrop.png", "res://assets/template/environment/foreground.png",
		"res://assets/template/characters/runner.png", "res://assets/template/characters/sentinel.png",
		"res://assets/template/powerups/overdrive.png", "res://assets/template/powerups/shield.png",
		"res://assets/template/powerups/slow_field.png", "res://assets/template/powerups/magnet.png",
		"res://assets/template/ui/title_glass.png", "res://assets/template/ui/pause_glass.png",
		"res://assets/template/fonts/NotoSansSC-VF.subset.woff2",
		"res://assets/template/fonts/Figtree-VF.subset.woff2",
		"res://assets/template/fonts/display/Sora-VF.subset.woff2",
	]:
		_check(ResourceLoader.exists(path), "required visual asset is missing: " + path)
	var foreground := (load("res://assets/template/environment/foreground.png") as Texture2D).get_image()
	_check(foreground.get_pixel(foreground.get_width() / 2, foreground.get_height() / 2).a == 0.0, "foreground center must be transparent")
	_check(not DirAccess.dir_exists_absolute("res://assets/template/audio/placeholders"), "default audio assets must not ship")
	_check(ResourceLoader.exists("res://assets/template/powerups/energy.png"), "energy node artwork must ship")


func _test_font_glyph_coverage() -> void:
	var probe := Label.new()
	get_tree().root.add_child(probe)
	var font: Font = probe.get_theme_font("font")
	probe.free()
	_check(font != null, "project font must load")
	if font == null:
		return
	_check(font == load("res://assets/template/fonts/ui_regular.tres"), "ui_regular must be the primary project font")
	_check(font is FontVariation and font.base_font.resource_path.ends_with("Figtree-VF.subset.woff2"), "primary font must use the Figtree body face")
	_check(font is FontVariation and not font.fallbacks.is_empty() and (font.fallbacks[0] as FontVariation).base_font.resource_path.ends_with("NotoSansSC-VF.subset.woff2"), "Chinese must fall back to Noto Sans SC")
	var label := Label.new()
	get_tree().root.add_child(label)
	_check(label.get_theme_font("font") == font, "dynamic controls must inherit the UI font")
	label.queue_free()
	var missing := PackedInt32Array()
	var seen := {}
	for locale: String in ["en", "zh-CN"]:
		_i18n.call("set_locale", locale)
		for key: String in _i18n.call("catalog_keys", locale):
			var localized := str(_i18n.call("t", key))
			for index: int in localized.length():
				var codepoint := localized.unicode_at(index)
				if codepoint >= 32 and not font.has_char(codepoint) and not seen.has(codepoint):
					seen[codepoint] = true
					missing.append(codepoint)
	for symbol: String in ["·", "×", "→", "←", "↑", "↓", "…"]:
		var codepoint := symbol.unicode_at(0)
		if not font.has_char(codepoint) and not seen.has(codepoint):
			seen[codepoint] = true
			missing.append(codepoint)
	_i18n.call("set_locale", "en")
	_check(missing.is_empty(), "bundled font is missing localized/runtime code points: %s" % [missing])


func _test_effect_pool() -> void:
	var effects := EffectsDirector.new()
	get_tree().root.add_child(effects)
	await get_tree().process_frame
	effects.configure(Vector2(588.0, 476.0))
	var baseline := effects.get_child_count()
	for index: int in 40:
		effects.burst(Vector2(index, index), Color.WHITE)
	_check(effects.get_child_count() == baseline, "bursts must recycle a fixed emitter pool")
	var snapshot := effects.debug_snapshot()
	_check(int(snapshot.burst_capacity) == 12, "burst pool must have a documented hard cap")
	_check(bool(snapshot.ambient), "effects must include an ambient emitter")
	_check(not snapshot.has("trail"), "effects must not recreate a continuous player trail")
	_check(int(snapshot.child_count) == 13, "effects must contain only the burst pool and ambient emitter")
	effects.queue_free()
	await get_tree().process_frame


func _test_runtime_scene() -> void:
	_save_store.call("set_tutorial_completed", false)
	var packed: PackedScene = load("res://scenes/main.tscn")
	_check(packed != null, "main scene must load")
	if packed == null:
		return
	var instance := packed.instantiate()
	get_tree().root.add_child(instance)
	await get_tree().process_frame
	await get_tree().process_frame
	_check(instance.get("_title_screen") != null and bool((instance.get("_title_screen") as Control).visible), "title screen must be visible on boot")
	_check(not instance.has_method("_open_tuning"), "Addon owns tuning UI; no duplicate game panel")
	_check(not FileAccess.file_exists("res://scripts/ui/tuning_panel.gd"), "native tuning panel is absent")
	instance.size = Vector2(1280.0, 1706.0)
	instance.call("_apply_responsive_layout")
	await get_tree().process_frame
	var title_rect: Rect2 = (instance.get("_title_panel") as Control).get_global_rect()
	_check(Rect2(Vector2.ZERO, instance.size).encloses(title_rect), "portrait title must fit the viewport")
	_check(title_rect.get_center().distance_to(instance.size * 0.5) < 2.0, "portrait title must remain centered")
	instance.call("_start_new_run")
	await get_tree().process_frame
	var world: MazeWorld = instance.get("_world")
	_check(world != null, "starting a run must create the maze world")
	if world != null:
		_check(world.remaining_collectibles() > 100, "stage must contain a meaningful collectible route")
		_check(world.get_pixel_size() == Vector2(588.0, 476.0), "world dimensions must be 21 by 17 at 28 pixels")
		_check(int(world.call("_wall_edge_mask", Vector2i(0, 0))) == 0, "outer wall corner must not draw internal borders")
		_check(int(world.call("_wall_edge_mask", Vector2i(1, 0))) == MazeWorld.WALL_EDGE_BOTTOM, "wall border must face the path only")
		_check(int(world.call("_wall_edge_mask", Vector2i(2, 2))) == MazeWorld.WALL_EDGE_TOP | MazeWorld.WALL_EDGE_BOTTOM | MazeWorld.WALL_EDGE_LEFT, "connected wall tiles must omit their internal divider")
		var before_score := world.score
		world.call("_on_runner_entered_cell", Vector2i(2, 1))
		_check(world.score == before_score + RunScoreService.event_value("energy"), "world scoring must use named score events")
		var effects_snapshot: Dictionary = world.call("debug_effects_snapshot")
		_check(int(effects_snapshot.get("burst_capacity", 0)) == 12, "runtime world must use the bounded effects director")
	var tutorial: Control = instance.get("_tutorial")
	_check(bool(tutorial.visible), "first Stage 1 run must show versioned event-driven onboarding")
	_check(not bool(_tuning.call("is_ranked_eligible")), "tutorial run must be unranked")
	_check((instance.get("_title_label") as Label).text == "Generic Game Template", "title must use the generic identity")
	for step: int in [0, 1, 2, 3, 4]:
		instance.call("_begin_tutorial")
		instance.set("_tutorial_state", step)
		_check((instance.get("_skip_tutorial_button") as Button).visible, "skip must remain visible at every tutorial step")
		instance.call("_skip_tutorial")
		_check(not tutorial.visible and int(instance.get("_tutorial_state")) == -1, "skipping must dismiss all tutorial state")
		_check(bool(world.get("_simulation_active")) and bool(world.get("_input_enabled")), "skipping must release input and simulation")
		_check(bool(_save_store.call("is_tutorial_completed")), "skipping must persist dismissal")
	instance.call("_begin_tutorial")
	tutorial.call("_on_continue")
	instance.set("_tutorial_state", 4)
	instance.call("_on_tutorial_continued")
	instance.call("_set_input_method", "touch")
	_check(bool((instance.get("_touch_controls") as Control).visible), "touch input must expose on-screen direction controls")
	_check(Rect2(Vector2.ZERO, instance.size).encloses((instance.get("_touch_controls") as Control).get_global_rect()), "touch controls must stay within the portrait viewport")
	instance.call("_set_input_method", "gamepad")
	_check(not bool((instance.get("_touch_controls") as Control).visible), "gamepad input must hide touch controls")
	instance.call("_toggle_pause")
	_check(bool((instance.get("_pause_screen") as Control).visible), "pause command must show the pause menu")
	instance.call("_request_destructive_action", "restart")
	_check(bool((instance.get("_confirm_screen") as Control).visible), "restart must require confirmation before discarding progress")
	instance.call("_cancel_destructive_action")
	_check(bool((instance.get("_pause_screen") as Control).visible), "canceling confirmation must preserve the paused run")
	instance.call("_toggle_pause")
	instance.call("_on_effects_changed", {"overdrive": 7.0, "shield": 10.0, "slow_field": 6.0, "magnet": 8.0})
	_check((instance.get("_power_label") as Label).visible, "active effect timers must remain visible")
	instance.set("_run_score", 250)
	instance.call("_finish_run", false)
	_check(bool((instance.get("_result_screen") as Control).visible), "defeat must reach the debrief screen")
	_check((instance.get("_result_score") as Label).text == "0", "debrief starts its score reveal at zero without flashing the final score")
	instance.call("_set_result_reveal", 1.0)
	_check((instance.get("_result_score") as Label).text == "250", "debrief ends its score reveal at the final score")
	_check(str((instance.get("_run_result") as Dictionary).get("outcome")) == "defeat", "defeat result must be immutable and explicit")
	_save_store.call("set_tutorial_completed", true)
	_tuning.call("reset_defaults")
	instance.call("_start_new_run")
	await get_tree().process_frame
	instance.set("_stage_index", 1)
	instance.call("_start_stage")
	await get_tree().process_frame
	var second_world: MazeWorld = instance.get("_world")
	_check(second_world != null and str(second_world.stage_data.get("id")) == "stage_2", "Stage 2 must instantiate from the data catalog")
	instance.call("_finish_run", true)
	_check(str((instance.get("_run_result") as Dictionary).get("outcome")) == "victory", "victory must reach a deterministic finalized result")
	(instance.get("_name_input") as LineEdit).text = "CLEANUP"
	instance.call("_submit_score")
	var saved_rows: Array = _save_store.call("get_leaderboard")
	_check(saved_rows.any(func(row: Dictionary) -> bool: return row.name == "CLEANUP"), "result submission must reach local standings")
	_check((instance.get("_result_status") as Label).text == _i18n.call("t", "result.saved_local"), "local submission must show its localized confirmation")
	_check((instance.get("_submit_button") as Button).disabled, "saved results must disable duplicate submissions")
	instance.call("_submit_score")
	_check(_save_store.call("get_leaderboard") == saved_rows, "repeated submit must not duplicate a result")
	instance.call("_show_leaderboard")
	await get_tree().process_frame
	_check((instance.get("_leaderboard_rows") as VBoxContainer).get_child_count() == saved_rows.size(), "leaderboard must render every local row")
	_i18n.call("set_locale", "zh-CN")
	_check((instance.get("_leaderboard_title") as Label).text == _i18n.call("t", "leaderboard.title"), "leaderboard must still switch languages")
	instance.call("_show_title")
	_check((instance.get("_title_screen") as Control).visible, "leaderboard must return to title")
	instance.call("_start_new_run")
	await get_tree().process_frame
	_check(instance.get("_world") != null and str(instance.get("_screen")) == "game", "a saved run must restart without the removed host adapter")
	_i18n.call("set_locale", "en")
	instance.queue_free()
	await get_tree().process_frame


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)
