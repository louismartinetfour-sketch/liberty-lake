extends Control
const OpenSourceLicenses = preload("res://scripts/manus/open_source_licenses.gd")

const MazeWorldType := preload("res://scripts/game/maze_world.gd")
const TutorialType := preload("res://scripts/ui/tutorial_callout.gd")
const RunScoreServiceType := preload("res://scripts/score/run_score_service.gd")
const BACKDROP := preload("res://assets/template/environment/backdrop.png")
const FOREGROUND := preload("res://assets/template/environment/foreground.png")
const RUNNER_ART := preload("res://assets/template/characters/runner.png")
const TITLE_FRAME := preload("res://assets/template/ui/title_glass.png")
const PAUSE_FRAME := preload("res://assets/template/ui/pause_glass.png")
const FILTER_SHADER := preload("res://shaders/arcade_filter.gdshader")
const LOGO_SHADER := preload("res://shaders/logo_chrome.gdshader")
const ENERGY_ICON := preload("res://assets/template/powerups/energy.png")
const MenuListType := preload("res://scripts/ui/menu_list.gd")
const TitleArtType := preload("res://scripts/ui/title_art.gd")
const ArenaFrameType := preload("res://scripts/ui/arena_frame.gd")
const TITLE_DESIGN_SIZE := Vector2(600.0, 540.0)
const TITLE_PORTRAIT_SIZE := Vector2(600.0, 1060.0)

var _backdrop: TextureRect
var _foreground: TextureRect
var _filter: ColorRect
var _filter_material: ShaderMaterial
var _world_root: Node2D
var _world: MazeWorld
var _feedback_flash: ColorRect

var _title_screen: Control
var _licenses_button: Button
var _title_panel: PanelContainer
var _title_frame: TextureRect
var _title_label: Label
var _subtitle_label: Label
var _tagline_label: Label
var _play_button: Button
var _leaderboard_button: Button
var _language_button: Button
var _tutorial_button: Button
var _title_status: Label

var _hud: Control
var _hud_panel: PanelContainer
var _score_label: Label
var _score_caption: Label
var _stage_caption: Label
var _lives_caption: Label
var _stage_label: Label
var _lives_label: Label
var _power_label: Label
var _pause_button: Button
var _stage_banner: Label

var _pause_screen: Control
var _pause_panel: PanelContainer
var _pause_frame: TextureRect
var _pause_title: Label
var _resume_button: Button
var _restart_button: Button
var _pause_title_button: Button
var _confirm_screen: Control
var _confirm_panel: PanelContainer
var _confirm_title: Label
var _confirm_message: Label
var _confirm_accept_button: Button
var _confirm_cancel_button: Button
var _pending_destructive_action := ""

var _result_screen: Control
var _result_panel: PanelContainer
var _result_title: Label
var _result_score: Label
var _result_score_caption: Label
var _result_time: Label
var _result_name_label: Label
var _name_input: LineEdit
var _submit_button: Button
var _result_status: Label
var _play_again_button: Button
var _result_title_button: Button

var _leaderboard_screen: Control
var _leaderboard_panel: PanelContainer
var _leaderboard_title: Label
var _leaderboard_rows: VBoxContainer
var _leaderboard_back_button: Button

var _tutorial: TutorialCallout
var _touch_controls: Control
var _skip_tutorial_button: Button
var _screen := "title"
var _stage_index := 0
var _run_score := 0
var _run_lives := 3
var _run_elapsed := 0.0
var _run_completed := false
var _score_saved := false
var _stage_start_score := 0
var _stage_start_lives := 3
var _tutorial_state := -1
var _force_tutorial := false
var _input_method := "keyboard"
var _tutorial_run := false
var _score_service: RunScoreService
var _run_result: Dictionary = {}
# Round-3 presentation layer (menus, key art, HUD widgets, transitions).
var _title_art: Control
var _title_menu: VBoxContainer
var _title_eyebrow_row: HBoxContainer
var _title_footer: HBoxContainer
var _title_hints: HBoxContainer
var _pause_menu: VBoxContainer
var _arena_frame: Control
var _transition: ColorRect
var _hud_chips: Array[PanelContainer] = []
var _stage_pips: Control
var _result_pips: Control
var _result_reveal := 1.0
var _shown_score := -1
var _shown_lives := -1


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_ensure_gamepad_bindings()
	_build_layers()
	_build_title_screen()
	_build_hud()
	_build_pause_screen()
	_build_confirmation_screen()
	_build_result_screen()
	_build_leaderboard_screen()
	_tutorial = TutorialType.new()
	add_child(_tutorial)
	_tutorial.continued.connect(_on_tutorial_continued)
	_build_touch_controls()
	_build_skip_tutorial_button()
	_pause_screen.visibility_changed.connect(_sync_world_actor_visibility)
	_confirm_screen.visibility_changed.connect(_sync_world_actor_visibility)
	_result_screen.visibility_changed.connect(_sync_world_actor_visibility)
	_leaderboard_screen.visibility_changed.connect(_sync_world_actor_visibility)
	_stage_banner.visibility_changed.connect(_sync_world_actor_visibility)
	_tutorial.visibility_changed.connect(_sync_world_actor_visibility)
	I18n.locale_changed.connect(_on_locale_changed)
	TuningStore.value_changed.connect(_on_tuning_value_changed)
	resized.connect(_layout_world)
	_apply_responsive_layout()
	_apply_filter_settings()
	_refresh_texts()
	call_deferred("_apply_responsive_layout")
	_show_title()
	AudioDirector.register_button(_confirm_cancel_button, true)
	for node: Node in find_children("*", "Button", true, false):
		AudioDirector.register_button(node as Button)


func _process(delta: float) -> void:
	if _screen == "game" and _world != null and not _pause_screen.visible and not _tutorial.visible:
		_run_elapsed += delta


func _input(event: InputEvent) -> void:
	# Observe touch before GUI consumption so tapping Start enables the pad.
	if event is InputEventScreenTouch and event.pressed:
		_set_input_method("touch")


func _unhandled_input(event: InputEvent) -> void:
	AudioDirector.unlock_audio()
	if event is InputEventScreenTouch:
		_set_input_method("touch")
	elif event is InputEventJoypadButton or event is InputEventJoypadMotion:
		_set_input_method("gamepad")
	elif event is InputEventKey:
		_set_input_method("keyboard")
	if event.is_action_pressed("pause"):
		if _confirm_screen.visible:
			_cancel_destructive_action()
		elif _tutorial.visible:
			get_viewport().set_input_as_handled()
			return
		elif _screen == "game":
			_toggle_pause()
		elif _screen == "leaderboard":
			_show_title()
		get_viewport().set_input_as_handled()


func _build_layers() -> void:
	_backdrop = TextureRect.new()
	_backdrop.texture = BACKDROP
	_backdrop.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_backdrop.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	_backdrop.mouse_filter = Control.MOUSE_FILTER_IGNORE
	ScreenFactory.full_rect(_backdrop)
	add_child(_backdrop)
	var wash := ColorRect.new()
	wash.color = Color(0.03, 0.04, 0.06, 0.15)
	wash.mouse_filter = Control.MOUSE_FILTER_IGNORE
	ScreenFactory.full_rect(wash)
	add_child(wash)
	_arena_frame = ArenaFrameType.new()
	ScreenFactory.full_rect(_arena_frame)
	_arena_frame.visible = false
	add_child(_arena_frame)
	_world_root = Node2D.new()
	_world_root.name = "WorldRoot"
	add_child(_world_root)
	_foreground = TextureRect.new()
	_foreground.texture = FOREGROUND
	_foreground.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_foreground.stretch_mode = TextureRect.STRETCH_SCALE
	_foreground.modulate = Color(1.0, 1.0, 1.0, 0.18)
	_foreground.mouse_filter = Control.MOUSE_FILTER_IGNORE
	ScreenFactory.full_rect(_foreground)
	add_child(_foreground)
	_filter = ColorRect.new()
	_filter.color = Color.WHITE
	_filter.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_filter_material = ShaderMaterial.new()
	_filter_material.shader = FILTER_SHADER
	_filter.material = _filter_material
	ScreenFactory.full_rect(_filter)
	add_child(_filter)
	_feedback_flash = ColorRect.new()
	_feedback_flash.color = Color(0.5, 0.7, 1.0, 0.0)
	_feedback_flash.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_feedback_flash.z_index = 20
	ScreenFactory.full_rect(_feedback_flash)
	add_child(_feedback_flash)
	_transition = ColorRect.new()
	_transition.color = Color(0.01, 0.015, 0.025, 0.0)
	_transition.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_transition.z_index = 90
	ScreenFactory.full_rect(_transition)
	add_child(_transition)


func _build_title_screen() -> void:
	_title_screen = Control.new()
	ScreenFactory.full_rect(_title_screen)
	add_child(_title_screen)
	# Key art owns the screen; the menu is anchored to the left like a console title.
	_title_art = TitleArtType.new()
	ScreenFactory.full_rect(_title_art)
	_title_screen.add_child(_title_art)
	var panel := PanelContainer.new()
	_title_panel = panel
	panel.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	panel.custom_minimum_size = TITLE_DESIGN_SIZE
	panel.size = TITLE_DESIGN_SIZE
	panel.z_index = 1
	_title_screen.add_child(panel)
	var content := VBoxContainer.new()
	content.alignment = BoxContainer.ALIGNMENT_CENTER
	content.add_theme_constant_override("separation", 0)
	panel.add_child(content)
	# Logo lockup: tracked eyebrow with an accent bar, chrome display title, tagline.
	_title_eyebrow_row = HBoxContainer.new()
	_title_eyebrow_row.add_theme_constant_override("separation", 12)
	_title_eyebrow_row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	content.add_child(_title_eyebrow_row)
	var bar := ColorRect.new()
	bar.color = ScreenFactory.CYAN
	bar.custom_minimum_size = Vector2(28.0, 3.0)
	bar.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_title_eyebrow_row.add_child(bar)
	_subtitle_label = ScreenFactory.display_label("", 14, ScreenFactory.CYAN, "eyebrow")
	_title_eyebrow_row.add_child(_subtitle_label)
	content.add_child(ScreenFactory.spacer(14.0))
	_title_label = ScreenFactory.display_label("", 64, ScreenFactory.TEXT, "title")
	_title_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_title_label.custom_minimum_size = Vector2(TITLE_DESIGN_SIZE.x, 0.0)
	_title_label.add_theme_constant_override("line_spacing", -10)
	_title_label.add_theme_color_override("font_shadow_color", Color(0.0, 0.02, 0.06, 0.75))
	_title_label.add_theme_constant_override("shadow_offset_x", 0)
	_title_label.add_theme_constant_override("shadow_offset_y", 5)
	_title_label.add_theme_color_override("font_outline_color", Color("0d1a2e"))
	_title_label.add_theme_constant_override("outline_size", 6)
	var logo_material := ShaderMaterial.new()
	logo_material.shader = LOGO_SHADER
	logo_material.set_shader_parameter("motion", 0.0 if ScreenFactory.reduced_motion() else 1.0)
	_title_label.material = logo_material
	_title_label.resized.connect(_sync_logo_shader)
	content.add_child(_title_label)
	content.add_child(ScreenFactory.spacer(12.0))
	_tagline_label = ScreenFactory.label("", 18, ScreenFactory.MUTED)
	_tagline_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	content.add_child(_tagline_label)
	content.add_child(ScreenFactory.spacer(36.0))
	# Menu list with a sliding selection cursor instead of a column of boxed buttons.
	_title_menu = MenuListType.new()
	_title_menu.item_font_size = 24
	_title_menu.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	content.add_child(_title_menu)
	_play_button = ScreenFactory.button("", 340.0)
	_play_button.pressed.connect(_start_new_run)
	_title_menu.add_child(_play_button)
	_leaderboard_button = ScreenFactory.button("", 340.0)
	_leaderboard_button.pressed.connect(_show_leaderboard)
	_title_menu.add_child(_leaderboard_button)
	_tutorial_button = ScreenFactory.button("", 340.0)
	_tutorial_button.pressed.connect(_arm_tutorial)
	_title_menu.add_child(_tutorial_button)
	content.add_child(ScreenFactory.spacer(8.0))
	_title_status = ScreenFactory.label("", 13, ScreenFactory.CYAN)
	_title_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_title_status.custom_minimum_size = Vector2(452.0, 22.0)
	content.add_child(_title_status)
	# Quiet utilities live in the bottom-left corner; key prompts sit bottom-centre.
	_title_footer = HBoxContainer.new()
	_title_footer.add_theme_constant_override("separation", 6)
	_title_footer.z_index = 2
	_title_screen.add_child(_title_footer)
	_language_button = ScreenFactory.quiet_button("", 13)
	var language_chip := ScreenFactory.glass_chip(Color.TRANSPARENT, Vector2(12.0, 5.0))
	_language_button.add_theme_stylebox_override("normal", language_chip)
	var language_hover := language_chip.duplicate() as StyleBoxFlat
	language_hover.border_color = Color(ScreenFactory.CYAN, 0.6)
	_language_button.add_theme_stylebox_override("hover", language_hover)
	_language_button.add_theme_color_override("font_color", ScreenFactory.MUTED)
	_language_button.add_theme_font_override("font", load(ScreenFactory.FONT_MEDIUM) as Font)
	_language_button.pressed.connect(I18n.toggle_locale)
	_title_footer.add_child(_language_button)
	_licenses_button = ScreenFactory.quiet_button("", 12)
	_licenses_button.name = "OpenSourceLicensesButton"
	_licenses_button.pressed.connect(OpenSourceLicenses.open.bind(self))
	_title_footer.add_child(_licenses_button)
	_title_hints = HBoxContainer.new()
	_title_hints.add_theme_constant_override("separation", 22)
	_title_hints.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_title_screen.add_child(_title_hints)
	for hint: Array in [["↑ ↓", "hint.navigate"], ["Enter", "hint.select"]]:
		var chip := ScreenFactory.key_hint(hint[0], "")
		chip.set_meta("locale_key", hint[1])
		_title_hints.add_child(chip)
	var title_frame := TextureRect.new()
	_title_frame = title_frame
	title_frame.texture = TITLE_FRAME
	title_frame.visible = false
	title_frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_title_screen.add_child(title_frame)
	_title_screen.visibility_changed.connect(func() -> void:
		if _title_screen.visible:
			_play_title_intro()
			_play_transition()
	)
	call_deferred("_play_title_intro")


func _chrome_material(line_height: float) -> ShaderMaterial:
	var chrome := ShaderMaterial.new()
	chrome.shader = LOGO_SHADER
	chrome.set_shader_parameter("line_height", line_height)
	chrome.set_shader_parameter("sweep_width", 500.0)
	chrome.set_shader_parameter("motion", 0.0 if ScreenFactory.reduced_motion() else 1.0)
	return chrome


func _sync_logo_shader() -> void:
	var logo_material := _title_label.material as ShaderMaterial
	if logo_material == null:
		return
	var pitch := float(_title_label.get_line_height()) + float(_title_label.get_theme_constant("line_spacing"))
	logo_material.set_shader_parameter("line_height", maxf(pitch, 1.0))
	logo_material.set_shader_parameter("sweep_width", _title_label.size.x)


## Staggered title entrance: art rises in, eyebrow/logo settle, menu items slide in.
func _play_title_intro() -> void:
	_title_art.play_intro()
	var parts: Array[Control] = [_title_eyebrow_row, _title_label, _tagline_label, _title_status, _title_footer, _title_hints]
	if ScreenFactory.reduced_motion():
		for part: Control in parts:
			part.modulate.a = 1.0
		_title_label.scale = Vector2.ONE
		_title_menu.play_intro()
		return
	for part: Control in parts:
		part.modulate.a = 0.0
	var tween := create_tween().set_parallel(true)
	tween.tween_property(_title_eyebrow_row, "modulate:a", 1.0, 0.3).set_delay(0.08)
	_title_label.pivot_offset = Vector2(0.0 if _title_label.horizontal_alignment == HORIZONTAL_ALIGNMENT_LEFT else _title_label.size.x * 0.5, _title_label.size.y * 0.5)
	_title_label.scale = Vector2(1.14, 1.14)
	tween.tween_property(_title_label, "modulate:a", 1.0, 0.35).set_delay(0.14)
	tween.tween_property(_title_label, "scale", Vector2.ONE, 0.7).set_delay(0.14).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tween.tween_property(_tagline_label, "modulate:a", 1.0, 0.4).set_delay(0.36)
	tween.tween_property(_title_status, "modulate:a", 1.0, 0.3).set_delay(0.7)
	tween.tween_property(_title_footer, "modulate:a", 1.0, 0.45).set_delay(0.85)
	tween.tween_property(_title_hints, "modulate:a", 1.0, 0.45).set_delay(0.9)
	_title_menu.play_intro(0.42)


## Short fade-from-black between title and gameplay.
func _play_transition() -> void:
	if _transition == null or ScreenFactory.reduced_motion():
		return
	_transition.color.a = 1.0
	create_tween().tween_property(_transition, "color:a", 0.0, 0.38).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)


func _layout_title(portrait: bool, menu_scale: float) -> void:
	var alignment := HORIZONTAL_ALIGNMENT_CENTER if portrait else HORIZONTAL_ALIGNMENT_LEFT
	for label: Label in [_title_label, _tagline_label, _title_status]:
		label.horizontal_alignment = alignment
	_title_eyebrow_row.alignment = BoxContainer.ALIGNMENT_CENTER if portrait else BoxContainer.ALIGNMENT_BEGIN
	_title_menu.size_flags_horizontal = Control.SIZE_SHRINK_CENTER if portrait else Control.SIZE_SHRINK_BEGIN
	_title_hints.visible = not portrait
	var content := _title_panel.get_child(0) as VBoxContainer
	var frame := _title_panel.get_theme_stylebox("panel") as StyleBoxEmpty
	if portrait:
		# Portrait: a tall centred panel with the lockup + menu at the bottom and the key art above it.
		content.alignment = BoxContainer.ALIGNMENT_END
		frame.content_margin_bottom = 80.0
		_fit_centered(_title_panel, TITLE_PORTRAIT_SIZE, 2.0)
		var panel_scale := _title_panel.scale.y
		var top := _title_panel.position.y + _title_panel.size.y * (1.0 - panel_scale) * 0.5
		var bottom := top + _title_panel.size.y * panel_scale
		var content_top := bottom - (content.get_combined_minimum_size().y + frame.content_margin_bottom) * panel_scale
		_title_art.art_scale = clampf((content_top - top) / 620.0, 0.55, 1.7)
		_title_art.hero_position = Vector2(size.x * 0.5, (top + content_top) * 0.5)
	else:
		content.alignment = BoxContainer.ALIGNMENT_CENTER
		frame.content_margin_bottom = 0.0
		_title_panel.set_anchors_preset(Control.PRESET_TOP_LEFT)
		_title_panel.size = TITLE_DESIGN_SIZE.max(_title_panel.get_combined_minimum_size())
		var fit := minf(1.0, (size.y - 120.0) / _title_panel.size.y)
		_title_panel.pivot_offset = Vector2.ZERO
		_title_panel.scale = Vector2.ONE * fit
		_title_panel.set_meta("fit_scale", _title_panel.scale)
		_title_panel.position = Vector2(maxf(56.0, size.x * 0.07), (size.y - _title_panel.size.y * fit) * 0.5 - 12.0)
		_title_art.art_scale = clampf(size.y / 720.0, 0.7, 1.4)
		_title_art.hero_position = Vector2(maxf(size.x * 0.715, _title_panel.position.x + 520.0 * fit + 330.0 * _title_art.art_scale), size.y * 0.5)
	menu_scale = 2.0 if portrait else 1.0
	var margin := 24.0 * menu_scale
	_title_footer.scale = Vector2.ONE * menu_scale
	_title_footer.size = _title_footer.get_combined_minimum_size()
	_title_footer.position = Vector2(margin, size.y - _title_footer.size.y * menu_scale - margin)
	_title_hints.size = _title_hints.get_combined_minimum_size()
	_title_hints.position = Vector2((size.x - _title_hints.size.x) * 0.5, size.y - _title_hints.size.y - 30.0)


func _make_stat(caption_color: Color, value_color: Color) -> Array[Label]:
	var block := VBoxContainer.new()
	block.add_theme_constant_override("separation", -2)
	block.mouse_filter = Control.MOUSE_FILTER_IGNORE
	block.alignment = BoxContainer.ALIGNMENT_CENTER
	var caption := ScreenFactory.display_label("", 11, caption_color, "eyebrow")
	var value := ScreenFactory.display_label("", 26, value_color, "heading")
	value.add_theme_color_override("font_outline_color", Color(0.0, 0.0, 0.0, 0.55))
	value.add_theme_constant_override("outline_size", 4)
	value.add_theme_color_override("font_shadow_color", Color(value_color, 0.35))
	value.add_theme_constant_override("shadow_offset_y", 0)
	value.add_theme_constant_override("shadow_outline_size", 8)
	block.add_child(caption)
	block.add_child(value)
	return [caption, value]


## Split a localized "CAPTION  {token}suffix" string into a small caption and a big value
## so HUD numbers can use the display face without changing localization keys.
func _stat_parts(key: String, token: String, value: String) -> PackedStringArray:
	var template := I18n.text(key)
	var marker := "{%s}" % token
	var at := template.find(marker)
	if at < 0:
		return PackedStringArray([template, value])
	var prefix := template.substr(0, at).strip_edges()
	var suffix := template.substr(at + marker.length()).strip_edges()
	return PackedStringArray([prefix, value + suffix])


## Glass HUD widget: accent edge, optional icon, caption/value stack.
func _make_chip(icon: Texture2D, stat: Array[Label], accent: Color) -> PanelContainer:
	var chip := PanelContainer.new()
	chip.mouse_filter = Control.MOUSE_FILTER_IGNORE
	chip.add_theme_stylebox_override("panel", ScreenFactory.glass_chip(accent, Vector2(14.0, 6.0)))
	chip.draw.connect(func() -> void:
		chip.draw_line(Vector2(10.0, 1.0), Vector2(chip.size.x - 10.0, 1.0), Color(1.0, 1.0, 1.0, 0.14), 1.0)
	)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	chip.add_child(row)
	if icon != null:
		var picture := TextureRect.new()
		picture.texture = icon
		picture.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		picture.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		picture.custom_minimum_size = Vector2(28.0, 28.0)
		picture.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		picture.mouse_filter = Control.MOUSE_FILTER_IGNORE
		picture.name = "Icon"
		row.add_child(picture)
	row.add_child(stat[0].get_parent())
	return chip


func _build_hud() -> void:
	_hud = Control.new()
	ScreenFactory.full_rect(_hud)
	_hud.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_hud)
	# Transparent layout strip: widgets are grouped as separate glass chips, not one dashboard bar.
	var panel := PanelContainer.new()
	_hud_panel = panel
	panel.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.minimum_size_changed.connect(_layout_world)
	panel.anchor_right = 1.0
	panel.offset_left = 26.0
	panel.offset_top = 16.0
	panel.offset_right = -26.0
	panel.offset_bottom = 92.0
	_hud.add_child(panel)
	var column := VBoxContainer.new()
	column.alignment = BoxContainer.ALIGNMENT_CENTER
	column.add_theme_constant_override("separation", 6)
	column.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(column)
	var row := HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_BEGIN
	row.add_theme_constant_override("separation", 12)
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	column.add_child(row)
	var score := _make_stat(ScreenFactory.SUBTLE, ScreenFactory.TEXT)
	var stage := _make_stat(ScreenFactory.SUBTLE, ScreenFactory.TEXT)
	var lives := _make_stat(ScreenFactory.SUBTLE, ScreenFactory.CORAL)
	_score_caption = score[0]
	_score_label = score[1]
	_stage_caption = stage[0]
	_stage_label = stage[1]
	_lives_caption = lives[0]
	_lives_label = lives[1]
	_hud_chips = [
		_make_chip(ENERGY_ICON, score, ScreenFactory.CYAN),
		_make_chip(null, stage, ScreenFactory.VIOLET),
		_make_chip(RUNNER_ART, lives, ScreenFactory.CORAL),
	]
	# Stage progress as segmented pips next to the stage number.
	_stage_pips = Control.new()
	_stage_pips.custom_minimum_size = Vector2(34.0, 26.0)
	_stage_pips.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_stage_pips.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_stage_pips.draw.connect(_draw_stage_pips)
	(_stage_label.get_parent().get_parent() as HBoxContainer).add_child(_stage_pips)
	for chip: PanelContainer in _hud_chips:
		row.add_child(chip)
	_power_label = ScreenFactory.medium_label("", 14, Color("c9d6e6"))
	_power_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_power_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_power_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_power_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_power_label.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_power_label.add_theme_color_override("font_outline_color", Color(0.0, 0.0, 0.0, 0.6))
	_power_label.add_theme_constant_override("outline_size", 4)
	row.add_child(_power_label)
	_pause_button = ScreenFactory.button("", 104.0)
	_pause_button.custom_minimum_size.y = 40.0
	_pause_button.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_pause_button.mouse_filter = Control.MOUSE_FILTER_STOP
	_pause_button.icon = _pause_icon()
	_pause_button.add_theme_constant_override("h_separation", 10)
	_pause_button.add_theme_color_override("icon_normal_color", ScreenFactory.CYAN)
	_pause_button.add_theme_color_override("icon_hover_color", Color.WHITE)
	_pause_button.add_theme_color_override("icon_focus_color", Color.WHITE)
	_pause_button.pressed.connect(_toggle_pause)
	row.add_child(_pause_button)
	_stage_banner = ScreenFactory.display_label("", 34, ScreenFactory.TEXT, "heading")
	_stage_banner.set_anchors_preset(Control.PRESET_CENTER)
	_stage_banner.position = Vector2(-260.0, -44.0)
	_stage_banner.size = Vector2(520.0, 88.0)
	_stage_banner.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_stage_banner.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_stage_banner.add_theme_color_override("font_outline_color", Color(ScreenFactory.CYAN, 0.35))
	_stage_banner.add_theme_constant_override("outline_size", 6)
	# Full-width holo band with bright rims: a "STAGE CLEAR" broadcast, not a card.
	var banner_style := ScreenFactory.style_box(Color(0.03, 0.05, 0.08, 0.9), Color(ScreenFactory.CYAN, 0.7), 0, 0)
	banner_style.border_width_top = 2
	banner_style.border_width_bottom = 2
	banner_style.expand_margin_left = 2000.0
	banner_style.expand_margin_right = 2000.0
	banner_style.shadow_color = Color(ScreenFactory.CYAN, 0.18)
	banner_style.shadow_size = 24
	_stage_banner.add_theme_stylebox_override("normal", banner_style)
	_stage_banner.visible = false
	_stage_banner.visibility_changed.connect(func() -> void:
		if not _stage_banner.visible or ScreenFactory.reduced_motion():
			return
		_stage_banner.pivot_offset = _stage_banner.size * 0.5
		_stage_banner.scale = Vector2(1.0, 0.2)
		_stage_banner.modulate.a = 0.0
		var tween := create_tween().set_parallel(true)
		tween.tween_property(_stage_banner, "scale", Vector2.ONE, 0.32).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
		tween.tween_property(_stage_banner, "modulate:a", 1.0, 0.18)
	)
	_hud.add_child(_stage_banner)
	_hud.visible = false
	_hud.visibility_changed.connect(func() -> void:
		_arena_frame.visible = _hud.visible
		if _hud.visible:
			_play_transition()
	)


func _pause_icon() -> ImageTexture:
	var image := Image.create(18, 18, false, Image.FORMAT_RGBA8)
	image.fill(Color.TRANSPARENT)
	image.fill_rect(Rect2i(3, 2, 4, 14), Color.WHITE)
	image.fill_rect(Rect2i(11, 2, 4, 14), Color.WHITE)
	return ImageTexture.create_from_image(image)


func _draw_stage_pips() -> void:
	var total := StageCatalog.count()
	var gap := 4.0
	var width := (_stage_pips.size.x - gap * float(total - 1)) / float(total)
	for index: int in total:
		var rect := Rect2(Vector2(index * (width + gap), _stage_pips.size.y * 0.5 - 3.0), Vector2(width, 6.0))
		var done := index <= _stage_index
		_stage_pips.draw_rect(rect, Color(ScreenFactory.CYAN, 0.95) if done else Color(1.0, 1.0, 1.0, 0.12))
		if index == _stage_index:
			_stage_pips.draw_rect(rect.grow(2.0), Color(ScreenFactory.CYAN, 0.25), false, 1.0)


## Number punch: scale kick + colour flash whenever a HUD value changes.
func _punch(label: Label, flash: Color) -> void:
	if ScreenFactory.reduced_motion() or not label.is_visible_in_tree():
		return
	label.pivot_offset = Vector2(0.0, label.size.y * 0.5)
	label.scale = Vector2(1.22, 1.22)
	label.modulate = flash
	var tween := label.create_tween().set_parallel(true)
	tween.tween_property(label, "scale", Vector2.ONE, 0.28).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tween.tween_property(label, "modulate", Color.WHITE, 0.3)


func _hud_divider() -> StyleBoxLine:
	var line := StyleBoxLine.new()
	line.color = Color("2c3440")
	line.vertical = true
	line.thickness = 1
	line.grow_begin = -6.0
	line.grow_end = -6.0
	return line


func _menu_heading(content: VBoxContainer, font_size: int, color: Color) -> Label:
	var heading := ScreenFactory.display_label("", font_size, color, "title")
	heading.add_theme_color_override("font_shadow_color", Color(0.0, 0.02, 0.06, 0.8))
	heading.add_theme_constant_override("shadow_offset_y", 4)
	heading.material = _chrome_material(float(font_size) * 1.3)
	heading.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	heading.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	heading.custom_minimum_size.x = 360.0
	content.add_child(heading)
	content.add_child(ScreenFactory.spacer(14.0))
	content.add_child(ScreenFactory.accent_rule(32.0, color))
	content.add_child(ScreenFactory.spacer(24.0))
	return heading


func _build_pause_screen() -> void:
	_pause_screen = _make_overlay()
	add_child(_pause_screen)
	var panel := _center_panel(_pause_screen, Vector2(460.0, 420.0), ScreenFactory.CYAN)
	_pause_panel = panel
	panel.z_index = 1
	var content := VBoxContainer.new()
	content.alignment = BoxContainer.ALIGNMENT_CENTER
	content.add_theme_constant_override("separation", 0)
	panel.add_child(content)
	_pause_title = _menu_heading(content, 34, ScreenFactory.TEXT)
	var actions := MenuListType.new()
	_pause_menu = actions
	actions.item_font_size = 21
	actions.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	content.add_child(actions)
	_resume_button = ScreenFactory.button("", 280.0)
	ScreenFactory.primary(_resume_button)
	_resume_button.pressed.connect(_toggle_pause)
	actions.add_child(_resume_button)
	_restart_button = ScreenFactory.button("", 280.0)
	_restart_button.pressed.connect(_request_destructive_action.bind("restart"))
	actions.add_child(_restart_button)
	_pause_title_button = ScreenFactory.button("", 280.0)
	_pause_title_button.pressed.connect(_request_destructive_action.bind("title"))
	actions.add_child(_pause_title_button)
	var pause_frame := TextureRect.new()
	_pause_frame = pause_frame
	pause_frame.texture = PAUSE_FRAME
	pause_frame.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	pause_frame.stretch_mode = TextureRect.STRETCH_SCALE
	pause_frame.modulate.a = 0.12
	pause_frame.set_anchors_preset(Control.PRESET_CENTER)
	pause_frame.position = Vector2(-290.0, -270.0)
	pause_frame.size = Vector2(580.0, 540.0)
	pause_frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	pause_frame.z_index = 0
	pause_frame.visible = false
	_pause_screen.add_child(pause_frame)
	content.add_child(ScreenFactory.spacer(18.0))
	var resume_hint := ScreenFactory.key_hint("Esc", "")
	resume_hint.set_meta("locale_key", "pause.resume")
	resume_hint.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	content.add_child(resume_hint)
	ScreenFactory.install_modal_motion(_pause_screen, panel)
	_pause_screen.visibility_changed.connect(func() -> void:
		if _pause_screen.visible:
			_pause_menu.play_intro(0.05)
	)
	_pause_screen.visible = false


func _build_confirmation_screen() -> void:
	_confirm_screen = _make_overlay()
	_confirm_screen.z_index = 60
	add_child(_confirm_screen)
	var panel := _center_panel(_confirm_screen, Vector2(520.0, 300.0), ScreenFactory.CORAL)
	_confirm_panel = panel
	var content := VBoxContainer.new()
	content.alignment = BoxContainer.ALIGNMENT_CENTER
	content.add_theme_constant_override("separation", 0)
	panel.add_child(content)
	var warning := ScreenFactory.display_label("!", 22, ScreenFactory.CORAL, "title")
	warning.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	var warning_style := ScreenFactory.style_box(Color(ScreenFactory.CORAL, 0.12), Color(ScreenFactory.CORAL, 0.6), 18, 2)
	warning_style.set_content_margin_all(0.0)
	warning.add_theme_stylebox_override("normal", warning_style)
	warning.custom_minimum_size = Vector2(36.0, 36.0)
	warning.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	warning.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	content.add_child(warning)
	content.add_child(ScreenFactory.spacer(14.0))
	_confirm_title = ScreenFactory.display_label("", 26, ScreenFactory.TEXT, "heading")
	_confirm_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	content.add_child(_confirm_title)
	content.add_child(ScreenFactory.spacer(10.0))
	_confirm_message = ScreenFactory.label("", 16, ScreenFactory.MUTED)
	_confirm_message.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_confirm_message.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_confirm_message.custom_minimum_size.x = 400.0
	content.add_child(_confirm_message)
	content.add_child(ScreenFactory.spacer(28.0))
	var actions := HBoxContainer.new()
	actions.alignment = BoxContainer.ALIGNMENT_CENTER
	actions.add_theme_constant_override("separation", 18)
	content.add_child(actions)
	_confirm_accept_button = ScreenFactory.button("", 190.0)
	_confirm_accept_button.add_theme_color_override("font_color", ScreenFactory.CORAL)
	_confirm_accept_button.add_theme_color_override("font_focus_color", Color("ffd2cc"))
	_confirm_accept_button.add_theme_stylebox_override("normal", ScreenFactory.plate(Color(0.16, 0.08, 0.09, 0.92), Color(ScreenFactory.CORAL, 0.45)))
	_confirm_accept_button.add_theme_stylebox_override("hover", ScreenFactory.plate(Color(0.24, 0.11, 0.12, 0.96), ScreenFactory.CORAL, Color(ScreenFactory.CORAL, 0.25)))
	_confirm_accept_button.add_theme_stylebox_override("focus", ScreenFactory._plate_focus(ScreenFactory.CORAL))
	_confirm_accept_button.pressed.connect(_confirm_destructive_action)
	actions.add_child(_confirm_accept_button)
	_confirm_cancel_button = ScreenFactory.button("", 190.0)
	ScreenFactory.primary(_confirm_cancel_button)
	_confirm_cancel_button.pressed.connect(_cancel_destructive_action)
	actions.add_child(_confirm_cancel_button)
	ScreenFactory.install_modal_motion(_confirm_screen, panel)
	_confirm_screen.visible = false


func _build_result_screen() -> void:
	_result_screen = _make_overlay()
	add_child(_result_screen)
	var panel := _center_panel(_result_screen, Vector2(580.0, 610.0), ScreenFactory.CYAN)
	_result_panel = panel
	var content := VBoxContainer.new()
	content.alignment = BoxContainer.ALIGNMENT_CENTER
	content.add_theme_constant_override("separation", 0)
	panel.add_child(content)
	_result_title = _menu_heading(content, 36, ScreenFactory.TEXT)
	_result_score_caption = ScreenFactory.display_label("", 12, ScreenFactory.SUBTLE, "eyebrow")
	_result_score_caption.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	content.add_child(_result_score_caption)
	# Big score with a glow halo, counted up when the debrief opens.
	_result_score = ScreenFactory.display_label("", 76, ScreenFactory.TEXT, "title")
	_result_score.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_result_score.add_theme_constant_override("line_spacing", -8)
	_result_score.add_theme_color_override("font_shadow_color", Color(0.0, 0.02, 0.06, 0.8))
	_result_score.add_theme_constant_override("shadow_offset_y", 5)
	_result_score.material = _chrome_material(99.0)
	# Soft energy halo behind the number (stylebox draws under the glyphs).
	var halo := StyleBoxTexture.new()
	halo.texture = ScreenFactory.radial_glow(Color.WHITE)
	halo.modulate_color = Color(0.3, 0.55, 1.0, 0.4)
	halo.expand_margin_left = 60.0
	halo.expand_margin_right = 60.0
	halo.expand_margin_top = 10.0
	halo.expand_margin_bottom = 10.0
	_result_score.add_theme_stylebox_override("normal", halo)
	content.add_child(_result_score)
	# Stats strip: stage progress pips + run time chip.
	var stats := HBoxContainer.new()
	stats.alignment = BoxContainer.ALIGNMENT_CENTER
	stats.add_theme_constant_override("separation", 14)
	content.add_child(stats)
	_result_pips = Control.new()
	_result_pips.custom_minimum_size = Vector2(72.0, 24.0)
	_result_pips.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_result_pips.draw.connect(_draw_result_pips)
	stats.add_child(_result_pips)
	_result_time = ScreenFactory.medium_label("", 15, ScreenFactory.TEXT)
	_result_time.add_theme_stylebox_override("normal", ScreenFactory.glass_chip(Color.TRANSPARENT, Vector2(12.0, 4.0)))
	stats.add_child(_result_time)
	content.add_child(ScreenFactory.spacer(26.0))
	_result_name_label = ScreenFactory.display_label("", 11, ScreenFactory.SUBTLE, "eyebrow")
	_result_name_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	content.add_child(_result_name_label)
	content.add_child(ScreenFactory.spacer(8.0))
	var form := HBoxContainer.new()
	form.alignment = BoxContainer.ALIGNMENT_CENTER
	form.add_theme_constant_override("separation", 14)
	content.add_child(form)
	_name_input = LineEdit.new()
	_name_input.text = SaveStore.get_player_name()
	_name_input.max_length = 18
	_name_input.custom_minimum_size = Vector2(250.0, 46.0)
	_name_input.alignment = HORIZONTAL_ALIGNMENT_CENTER
	_name_input.add_theme_font_size_override("font_size", 18)
	_name_input.add_theme_font_override("font", load(ScreenFactory.FONT_MENU) as Font)
	_name_input.add_theme_color_override("font_color", ScreenFactory.TEXT)
	_name_input.add_theme_color_override("font_placeholder_color", ScreenFactory.SUBTLE)
	_name_input.add_theme_color_override("caret_color", ScreenFactory.CYAN)
	_name_input.add_theme_color_override("selection_color", Color(ScreenFactory.CYAN, 0.3))
	# Inset "terminal" field: dark well with a glowing underline instead of a bordered box.
	var field := ScreenFactory.style_box(Color(0.0, 0.0, 0.0, 0.35), Color(1.0, 1.0, 1.0, 0.18), 4, 0)
	field.border_width_bottom = 2
	_name_input.add_theme_stylebox_override("normal", field)
	var field_focus := field.duplicate() as StyleBoxFlat
	field_focus.border_color = ScreenFactory.CYAN
	field_focus.bg_color = Color(ScreenFactory.CYAN, 0.08)
	field_focus.shadow_color = Color(ScreenFactory.CYAN, 0.2)
	field_focus.shadow_size = 10
	_name_input.add_theme_stylebox_override("focus", field_focus)
	form.add_child(_name_input)
	_submit_button = ScreenFactory.button("", 150.0)
	form.add_child(_submit_button)
	_submit_button.pressed.connect(_submit_score)
	content.add_child(ScreenFactory.spacer(6.0))
	_result_status = ScreenFactory.label("", 13, ScreenFactory.CYAN)
	_result_status.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_result_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_result_status.custom_minimum_size = Vector2(440.0, 22.0)
	content.add_child(_result_status)
	content.add_child(ScreenFactory.spacer(16.0))
	var actions := HBoxContainer.new()
	actions.alignment = BoxContainer.ALIGNMENT_CENTER
	actions.add_theme_constant_override("separation", 18)
	content.add_child(actions)
	_play_again_button = ScreenFactory.button("", 210.0)
	ScreenFactory.primary(_play_again_button)
	_play_again_button.pressed.connect(_start_new_run)
	actions.add_child(_play_again_button)
	var standings := ScreenFactory.button("", 210.0)
	standings.custom_minimum_size.y = 52.0
	standings.pressed.connect(_show_leaderboard)
	standings.set_meta("locale_key", "menu.leaderboard")
	actions.add_child(standings)
	content.add_child(ScreenFactory.spacer(10.0))
	_result_title_button = ScreenFactory.quiet_button("", 14)
	_result_title_button.add_theme_color_override("font_color", ScreenFactory.MUTED)
	_result_title_button.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	_result_title_button.pressed.connect(_show_title)
	content.add_child(_result_title_button)
	ScreenFactory.install_modal_motion(_result_screen, panel)
	_result_screen.visibility_changed.connect(_play_result_reveal)
	_result_screen.visible = false


## Debrief reveal: the score counts up with a settle kick, then the stage pips light up.
func _play_result_reveal() -> void:
	if not _result_screen.visible:
		return
	_result_pips.queue_redraw()
	if ScreenFactory.reduced_motion():
		_result_reveal = 1.0
		_refresh_result_texts()
		return
	_result_reveal = 0.0
	var tween := create_tween()
	tween.tween_method(_set_result_reveal, 0.0, 1.0, 0.95).set_delay(0.15).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tween.tween_callback(func() -> void:
		_result_score.pivot_offset = _result_score.size * 0.5
		_result_score.scale = Vector2(1.12, 1.12)
		_result_score.create_tween().tween_property(_result_score, "scale", Vector2.ONE, 0.3).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	)


func _set_result_reveal(value: float) -> void:
	_result_reveal = value
	var parts := _stat_parts("result.score", "score", str(roundi(float(_run_score) * value)))
	_result_score.text = parts[1]
	_result_pips.queue_redraw()


func _draw_result_pips() -> void:
	var total := StageCatalog.count()
	var reached := _stage_index + 1 if _run_completed else _stage_index
	var gap := 6.0
	var width := (_result_pips.size.x - gap * float(total - 1)) / float(total)
	for index: int in total:
		var lit := clampf(_result_reveal * float(total) - float(index), 0.0, 1.0) if index < reached else 0.0
		var rect := Rect2(Vector2(index * (width + gap), _result_pips.size.y * 0.5 - 4.0), Vector2(width, 8.0))
		_result_pips.draw_rect(rect, Color(1.0, 1.0, 1.0, 0.1))
		if lit > 0.0:
			_result_pips.draw_rect(Rect2(rect.position, Vector2(rect.size.x * lit, rect.size.y)), ScreenFactory.CYAN)
			_result_pips.draw_rect(rect.grow(3.0), Color(ScreenFactory.CYAN, 0.18 * lit), false, 2.0)


func _build_leaderboard_screen() -> void:
	_leaderboard_screen = _make_overlay()
	add_child(_leaderboard_screen)
	var panel := _center_panel(_leaderboard_screen, Vector2(700.0, 620.0), ScreenFactory.CYAN)
	_leaderboard_panel = panel
	var content := VBoxContainer.new()
	content.add_theme_constant_override("separation", 0)
	panel.add_child(content)
	_leaderboard_title = _menu_heading(content, 34, ScreenFactory.TEXT)
	_leaderboard_rows = VBoxContainer.new()
	_leaderboard_rows.add_theme_constant_override("separation", 6)
	_leaderboard_rows.custom_minimum_size = Vector2(600.0, 400.0)
	_leaderboard_rows.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	content.add_child(_leaderboard_rows)
	content.add_child(ScreenFactory.spacer(16.0))
	var footer := HBoxContainer.new()
	footer.alignment = BoxContainer.ALIGNMENT_CENTER
	footer.add_theme_constant_override("separation", 18)
	content.add_child(footer)
	_leaderboard_back_button = ScreenFactory.button("", 200.0)
	_leaderboard_back_button.pressed.connect(_show_title)
	footer.add_child(_leaderboard_back_button)
	footer.add_child(ScreenFactory.key_hint("Esc", ""))
	ScreenFactory.install_modal_motion(_leaderboard_screen, panel)
	_leaderboard_screen.visible = false


func _make_overlay() -> Control:
	var overlay := Control.new()
	ScreenFactory.full_rect(overlay)
	ScreenFactory.modal_backdrop(overlay)
	return overlay


func _center_panel(parent: Control, panel_size: Vector2, border: Color) -> PanelContainer:
	var panel := ScreenFactory.holo_panel(border, Vector2(44.0, 34.0))
	panel.set_anchors_preset(Control.PRESET_CENTER)
	panel.position = -panel_size * 0.5
	panel.size = panel_size
	panel.custom_minimum_size = panel_size
	parent.add_child(panel)
	return panel


func _build_skip_tutorial_button() -> void:
	_skip_tutorial_button = ScreenFactory.button("", 170.0)
	_skip_tutorial_button.z_index = 81
	_skip_tutorial_button.pressed.connect(_skip_tutorial)
	_skip_tutorial_button.visible = false
	add_child(_skip_tutorial_button)


func _build_touch_controls() -> void:
	_touch_controls = Control.new()
	_touch_controls.name = "TouchControls"
	_touch_controls.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	_touch_controls.position = Vector2(20.0, -198.0)
	_touch_controls.size = Vector2(190.0, 178.0)
	_touch_controls.z_index = 45
	add_child(_touch_controls)
	var directions := {
		"↑": {"position": Vector2(64.0, 0.0), "direction": Vector2i.UP},
		"←": {"position": Vector2(0.0, 58.0), "direction": Vector2i.LEFT},
		"↓": {"position": Vector2(64.0, 116.0), "direction": Vector2i.DOWN},
		"→": {"position": Vector2(128.0, 58.0), "direction": Vector2i.RIGHT},
	}
	for glyph: String in directions:
		var button := ScreenFactory.button(glyph, 58.0)
		button.position = directions[glyph].position
		button.custom_minimum_size = Vector2(58.0, 58.0)
		button.size = Vector2(58.0, 58.0)
		button.focus_mode = Control.FOCUS_NONE
		button.modulate.a = 0.82
		for state: String in ["normal", "hover", "pressed"]:
			var key := ScreenFactory.style_box(Color(0.06, 0.08, 0.11, 0.78) if state != "pressed" else Color(ScreenFactory.CYAN, 0.35), Color(ScreenFactory.CYAN, 0.35 if state == "normal" else 0.8), 29, 2)
			key.shadow_color = Color(0.0, 0.0, 0.0, 0.4)
			key.shadow_size = 10
			button.add_theme_stylebox_override(state, key)
		button.button_down.connect(_on_touch_direction.bind(directions[glyph].direction))
		_touch_controls.add_child(button)
	_touch_controls.visible = false


func _ensure_gamepad_bindings() -> void:
	var axes := {
		"move_left": [JOY_AXIS_LEFT_X, -1.0],
		"move_right": [JOY_AXIS_LEFT_X, 1.0],
		"move_up": [JOY_AXIS_LEFT_Y, -1.0],
		"move_down": [JOY_AXIS_LEFT_Y, 1.0],
	}
	for action: String in axes:
		var motion := InputEventJoypadMotion.new()
		motion.axis = axes[action][0]
		motion.axis_value = axes[action][1]
		InputMap.action_add_event(action, motion)
	var buttons := {
		"move_left": JOY_BUTTON_DPAD_LEFT,
		"move_right": JOY_BUTTON_DPAD_RIGHT,
		"move_up": JOY_BUTTON_DPAD_UP,
		"move_down": JOY_BUTTON_DPAD_DOWN,
		"pause": JOY_BUTTON_START,
	}
	for action: String in buttons:
		var button := InputEventJoypadButton.new()
		button.button_index = buttons[action]
		InputMap.action_add_event(action, button)


func _on_touch_direction(direction: Vector2i) -> void:
	_set_input_method("touch")
	if _world != null:
		_world.request_player_direction(direction)


func _set_input_method(method: String) -> void:
	if method not in ["keyboard", "gamepad", "touch"]:
		return
	_input_method = method
	if _tutorial_state == 0 and _tutorial != null and _tutorial.visible:
		_tutorial.set_input_hint(_tutorial_input_hint())
	if _touch_controls != null:
		_touch_controls.visible = method == "touch" and _screen == "game" and not _pause_screen.visible and not _tutorial.visible


func _show_feedback(kind: String) -> void:
	if _feedback_flash == null:
		return
	var colors := {
		"reward": Color(0.5, 0.72, 1.0, 0.07),
		"impact": Color(0.7, 0.8, 1.0, 0.10),
		"damage": Color(1.0, 0.35, 0.3, 0.14),
		"stage_clear": Color(0.75, 0.9, 1.0, 0.12),
	}
	_feedback_flash.color = colors.get(kind, Color(1.0, 1.0, 1.0, 0.12))
	var duration := 0.08 if bool(TuningStore.get_value("ui.reduced_motion", false)) else 0.28
	var tween := create_tween()
	tween.tween_property(_feedback_flash, "color:a", 0.0, duration)


func _start_new_run() -> void:
	AudioDirector.unlock_audio()
	_stage_index = 0
	_run_score = 0
	_tutorial_run = _force_tutorial or not SaveStore.is_tutorial_completed()
	TuningStore.begin_run(_tutorial_run)
	_run_lives = int(TuningStore.get_value("player.lives", 3.0))
	_run_elapsed = 0.0
	_score_saved = false
	_run_completed = false
	_run_result.clear()
	_score_service = RunScoreServiceType.new()
	_score_service.begin()
	AudioDirector.play_music("music.gameplay")
	_start_stage()


func _start_stage() -> void:
	AudioDirector.set_game_paused(false)
	_tutorial.visible = false
	_skip_tutorial_button.visible = false
	_clear_world()
	TuningStore.apply_boundary("NEXT_STAGE")
	_stage_start_score = _run_score
	_stage_start_lives = _run_lives
	_screen = "game"
	_title_screen.visible = false
	_result_screen.visible = false
	_leaderboard_screen.visible = false
	_pause_screen.visible = false
	_confirm_screen.visible = false
	_hud.visible = true
	_world = MazeWorldType.new()
	_world_root.add_child(_world)
	_world.setup(StageCatalog.get_stage(_stage_index), _run_score, _run_lives, _score_service)
	_world.stats_changed.connect(_on_stats_changed)
	_world.effects_changed.connect(_on_effects_changed)
	_world.player_moved.connect(_on_tutorial_player_moved)
	_world.pellet_collected.connect(_on_tutorial_pellet_collected)
	_world.stage_completed.connect(_on_stage_completed)
	_world.run_failed.connect(_on_run_failed)
	_world.feedback_requested.connect(_show_feedback)
	_layout_world()
	_sync_world_actor_visibility()
	_on_stats_changed(_run_score, _run_lives)
	_on_effects_changed({})
	if _stage_index == 0 and _tutorial_run:
		_begin_tutorial()
	_set_input_method(_input_method)


func _restart_stage() -> void:
	_run_score = _stage_start_score
	_run_lives = _stage_start_lives
	_score_service.begin(_stage_start_score)
	_pause_screen.visible = false
	_start_stage()


func _on_stage_completed(updated_score: int, updated_lives: int) -> void:
	_run_score = updated_score
	_run_lives = updated_lives
	_stage_banner.text = I18n.text("result.stage_clear", {"stage": _stage_index + 1})
	_stage_banner.visible = true
	await get_tree().create_timer(1.1).timeout
	_stage_banner.visible = false
	if _stage_index + 1 < StageCatalog.count():
		_stage_index += 1
		_start_stage()
	else:
		_finish_run(true)


func _on_run_failed(updated_score: int) -> void:
	_run_score = updated_score
	_run_lives = 0
	_finish_run(false)


func _finish_run(completed: bool) -> void:
	_screen = "result"
	_run_completed = completed
	_run_result = _score_service.finalize(
		_stage_index + 1,
		"victory" if completed else "defeat",
		_run_elapsed,
		TuningStore.is_ranked_eligible(),
		TuningStore.configuration_marker(),
		_tutorial_run,
	)
	TuningStore.end_run()
	AudioDirector.play_cue("game.victory" if completed else "game.defeat")
	if _world != null:
		_world.set_simulation_active(false)
	_hud.visible = false
	_pause_screen.visible = false
	_confirm_screen.visible = false
	_result_screen.visible = true
	_score_saved = false
	_submit_button.disabled = false
	_result_status.text = ""
	_name_input.text = SaveStore.get_player_name()
	_refresh_result_texts()
	_submit_button.grab_focus()


func _submit_score() -> void:
	if _score_saved:
		return
	SaveStore.record_result(_name_input.text, _run_result)
	_score_saved = true
	_submit_button.disabled = true
	_result_status.text = I18n.t("result.saved_local")


func _show_title() -> void:
	AudioDirector.set_game_paused(false)
	_tutorial.visible = false
	_skip_tutorial_button.visible = false
	TuningStore.end_run()
	_clear_world()
	_screen = "title"
	_title_screen.visible = true
	_hud.visible = false
	_pause_screen.visible = false
	_confirm_screen.visible = false
	_result_screen.visible = false
	_leaderboard_screen.visible = false
	_tutorial_state = -1
	_title_status.text = ""
	AudioDirector.play_music("music.title")
	_set_input_method(_input_method)
	_play_button.grab_focus()


func _show_leaderboard() -> void:
	if _world != null:
		_world.set_simulation_active(false)
	_screen = "leaderboard"
	_title_screen.visible = false
	_hud.visible = false
	_pause_screen.visible = false
	_confirm_screen.visible = false
	_result_screen.visible = false
	_leaderboard_screen.visible = true
	_refresh_leaderboard_rows()
	_leaderboard_back_button.grab_focus()


func _refresh_leaderboard_rows() -> void:
	for child: Node in _leaderboard_rows.get_children():
		child.queue_free()
	var rows := SaveStore.get_leaderboard()
	if rows.is_empty():
		var empty := ScreenFactory.label(I18n.text("leaderboard.empty"), 18, ScreenFactory.MUTED)
		empty.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		empty.custom_minimum_size.y = 120.0
		empty.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		_leaderboard_rows.add_child(empty)
		return
	# The localized row template separates columns with runs of spaces; render them as a table.
	var columns := PackedStringArray()
	for part: String in I18n.t("leaderboard.row").split("   ", false):
		if not part.strip_edges().is_empty():
			columns.append(part.strip_edges())
	var medal_colors := [Color("ffd27a"), Color("d5dde8"), Color("e0a07a")]
	for index: int in rows.size():
		var row: Dictionary = rows[index]
		var values := {
			"rank": index + 1,
			"name": row.name,
			"score": row.score,
			"stage": row.stage,
			"time": "%.1f" % float(row.time),
		}
		var leader := index == 0
		var line := PanelContainer.new()
		var line_style := ScreenFactory.plate(
			Color(ScreenFactory.CYAN, 0.13) if leader else Color(1.0, 1.0, 1.0, 0.045 if index % 2 == 0 else 0.02),
			Color(ScreenFactory.CYAN, 0.55) if leader else Color(1.0, 1.0, 1.0, 0.05),
			Color(ScreenFactory.CYAN, 0.16) if leader else Color.TRANSPARENT,
			0.12,
		)
		line_style.content_margin_top = 5.0
		line_style.content_margin_bottom = 5.0
		line_style.content_margin_left = 14.0
		line_style.content_margin_right = 18.0
		line.add_theme_stylebox_override("panel", line_style)
		line.custom_minimum_size.y = 40.0
		var cells := HBoxContainer.new()
		cells.add_theme_constant_override("separation", 16)
		line.add_child(cells)
		for column: int in columns.size():
			var text := columns[column]
			for token: String in values:
				text = text.replace("{%s}" % token, str(values[token]))
			var cell: Label
			if column == 0:
				# "{rank}. {name}" → rank badge + name.
				var split := text.find(". ")
				if split > 0:
					var badge := ScreenFactory.display_label(text.substr(0, split), 14, ScreenFactory.INK if index < 3 else ScreenFactory.MUTED, "heading")
					badge.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
					badge.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
					badge.custom_minimum_size = Vector2(28.0, 28.0)
					badge.size_flags_vertical = Control.SIZE_SHRINK_CENTER
					var badge_style := ScreenFactory.style_box(medal_colors[index] if index < 3 else Color(1.0, 1.0, 1.0, 0.06), Color(1.0, 1.0, 1.0, 0.5 if index < 3 else 0.1), 14, 1)
					badge_style.set_content_margin_all(0.0)
					badge.add_theme_stylebox_override("normal", badge_style)
					cells.add_child(badge)
					text = text.substr(split + 2)
				cell = ScreenFactory.medium_label(text, 17, ScreenFactory.TEXT)
				cell.size_flags_horizontal = Control.SIZE_EXPAND_FILL
				cell.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
			elif column == 1:
				cell = ScreenFactory.display_label(text, 19, ScreenFactory.CYAN if leader else ScreenFactory.TEXT, "heading")
				cell.custom_minimum_size.x = 96.0
				cell.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
			else:
				cell = ScreenFactory.label(text, 15, ScreenFactory.MUTED)
				cell.custom_minimum_size.x = 76.0
				cell.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
			cell.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
			cells.add_child(cell)
		_leaderboard_rows.add_child(line)
		if not ScreenFactory.reduced_motion():
			line.modulate.a = 0.0
			create_tween().tween_property(line, "modulate:a", 1.0, 0.25).set_delay(0.12 + index * 0.05)


func _toggle_pause() -> void:
	if _screen != "game" or _world == null:
		return
	var opening := not _pause_screen.visible
	_pause_screen.visible = opening
	_world.set_simulation_active(not opening)
	_world.set_input_enabled(not opening)
	AudioDirector.set_game_paused(opening)
	_set_input_method(_input_method)
	if opening:
		_resume_button.grab_focus()


func _request_destructive_action(action: String) -> void:
	if action not in ["restart", "title"] or _screen != "game":
		return
	_pending_destructive_action = action
	_confirm_title.text = I18n.t("confirm.heading")
	_confirm_message.text = I18n.t("confirm.%s" % action)
	_confirm_accept_button.text = I18n.t("confirm.accept")
	_confirm_cancel_button.text = I18n.t("confirm.cancel")
	_confirm_screen.visible = true
	_confirm_accept_button.grab_focus()


func _confirm_destructive_action() -> void:
	var action := _pending_destructive_action
	_pending_destructive_action = ""
	_confirm_screen.visible = false
	if action == "restart":
		_restart_stage()
	elif action == "title":
		_show_title()


func _cancel_destructive_action() -> void:
	_pending_destructive_action = ""
	_confirm_screen.visible = false
	if _pause_screen.visible:
		_resume_button.grab_focus()


func _sync_world_actor_visibility() -> void:
	if _world == null:
		return
	var actors_obscured := (
		_pause_screen.visible
		or _confirm_screen.visible
		or _result_screen.visible
		or _leaderboard_screen.visible
		or _stage_banner.visible
	)
	_world.set_actors_visible(_screen == "game" and not actors_obscured)


func _arm_tutorial() -> void:
	_force_tutorial = true
	SaveStore.set_tutorial_completed(false)
	_title_status.text = I18n.text("tutorial.replay_armed")


func _begin_tutorial() -> void:
	_skip_tutorial_button.visible = true
	_tutorial_state = 0
	_world.set_simulation_active(false)
	_world.set_input_enabled(false)
	_tutorial.show_callout(I18n.t("tutorial.move.title"), I18n.t("tutorial.move"), _tutorial_input_hint(), _world.get_runner_screen_position())
	_set_input_method(_input_method)


func _skip_tutorial() -> void:
	_tutorial_state = -1
	_force_tutorial = false
	_tutorial.visible = false
	_skip_tutorial_button.visible = false
	SaveStore.set_tutorial_completed(true, SaveStore.TUTORIAL_VERSION)
	if _world != null and _screen == "game":
		_world.set_simulation_active(not _pause_screen.visible)
		_world.set_input_enabled(not _pause_screen.visible)
	_set_input_method(_input_method)
	_pause_button.grab_focus()


func _on_tutorial_continued() -> void:
	if _world == null:
		return
	match _tutorial_state:
		0:
			_tutorial_state = 1
			_world.set_simulation_active(true)
			_world.set_input_enabled(true)
		2:
			_tutorial_state = 3
			_world.set_simulation_active(true)
			_world.set_input_enabled(true)
		4:
			_skip_tutorial_button.visible = false
			_tutorial_state = -1
			_force_tutorial = false
			SaveStore.set_tutorial_completed(true, SaveStore.TUTORIAL_VERSION)
			_world.set_simulation_active(true)
			_world.set_input_enabled(true)


func _on_tutorial_player_moved() -> void:
	if _tutorial_state != 1 or _world == null:
		return
	_tutorial_state = 2
	_world.set_simulation_active(false)
	_world.set_input_enabled(false)
	_tutorial.show_callout(I18n.t("tutorial.collect.title"), I18n.t("tutorial.collect"), I18n.t("tutorial.input.collect"), _world.get_runner_screen_position())


func _on_tutorial_pellet_collected() -> void:
	if _tutorial_state != 3 or _world == null:
		return
	_tutorial_state = 4
	_world.set_simulation_active(false)
	_world.set_input_enabled(false)
	_tutorial.show_callout(I18n.t("tutorial.power.title"), I18n.t("tutorial.power"), I18n.t("tutorial.input.pause"), _world.get_runner_screen_position())


func _tutorial_input_hint() -> String:
	return I18n.t("tutorial.input.%s" % _input_method)


func _on_stats_changed(updated_score: int, updated_lives: int) -> void:
	_run_score = updated_score
	_run_lives = updated_lives
	for stat: Array in [
		[_score_caption, _score_label, "hud.score", "score", str(updated_score)],
		[_stage_caption, _stage_label, "hud.stage", "stage", str(_stage_index + 1)],
		[_lives_caption, _lives_label, "hud.lives", "lives", str(updated_lives)],
	]:
		var parts := _stat_parts(stat[2], stat[3], stat[4])
		(stat[0] as Label).text = parts[0].to_upper()
		(stat[1] as Label).text = parts[1]
	if _shown_score >= 0 and updated_score > _shown_score:
		_punch(_score_label, Color("cfe6ff"))
	if _shown_lives >= 0 and updated_lives != _shown_lives:
		_punch(_lives_label, Color(2.0, 0.8, 0.8))
	_shown_score = updated_score
	_shown_lives = updated_lives
	_stage_pips.queue_redraw()


func _on_effects_changed(active_effects: Dictionary) -> void:
	var summaries := PackedStringArray()
	for effect: String in ["overdrive", "shield", "slow_field", "magnet"]:
		var seconds := float(active_effects.get(effect, 0.0))
		if seconds > 0.0:
			summaries.append(I18n.text("hud." + effect, {"seconds": "%.1f" % seconds}))
	_power_label.text = I18n.text("hud.ready") if summaries.is_empty() else "  ·  ".join(summaries)


func _layout_world() -> void:
	_apply_responsive_layout()
	if _world == null or not is_instance_valid(_world):
		return
	var pixel_size := _world.get_pixel_size()
	var portrait := size.y > size.x * 1.15
	var top := maxf(130.0, _hud_panel.get_rect().end.y + 22.0)
	var bottom := 335.0 if portrait else 40.0
	var available := Vector2(maxf(200.0, size.x - 80.0), maxf(200.0, size.y - top - bottom))
	var zoom := float(TuningStore.get_value("environment.camera.zoom", 1.0))
	var scale_cap := 1.65 if portrait else 1.12
	var scale_factor := minf(minf(available.x / pixel_size.x, available.y / pixel_size.y), scale_cap * zoom)
	_world.scale = Vector2.ONE * scale_factor
	var scaled_size := pixel_size * scale_factor
	_world.position = Vector2((size.x - scaled_size.x) * 0.5, top + (available.y - scaled_size.y) * 0.5)
	_arena_frame.set_arena(Rect2(_world.position, scaled_size))


func _apply_responsive_layout() -> void:
	if _title_panel == null or _skip_tutorial_button == null:
		return
	var portrait := size.y > size.x * 1.15
	var menu_scale := 1.65 if portrait else 1.0
	_layout_title(portrait, menu_scale)
	_fit_centered(_title_frame, Vector2(672.0, 750.0), menu_scale)
	_fit_centered(_pause_panel, Vector2(460.0, 420.0), menu_scale)
	_fit_centered(_pause_frame, Vector2(580.0, 540.0), menu_scale)
	_fit_centered(_result_panel, Vector2(580.0, 610.0), menu_scale)
	_fit_centered(_confirm_panel, Vector2(520.0, 300.0), menu_scale)
	_fit_centered(_leaderboard_panel, Vector2(700.0, 620.0), menu_scale)
	_hud_panel.offset_bottom = 124.0 if portrait else 92.0
	for label: Label in [_score_label, _stage_label, _lives_label]:
		label.add_theme_font_size_override("font_size", 40 if portrait else 26)
	for chip: PanelContainer in _hud_chips:
		var icon := chip.find_child("Icon", true, false) as Control
		if icon != null:
			icon.custom_minimum_size = Vector2.ONE * (44.0 if portrait else 28.0)
	_stage_pips.custom_minimum_size = Vector2(52.0, 36.0) if portrait else Vector2(34.0, 26.0)
	_pause_button.add_theme_constant_override("icon_max_width", 28 if portrait else 18)
	for label: Label in [_score_caption, _stage_caption, _lives_caption]:
		label.add_theme_font_size_override("font_size", 17 if portrait else 11)
	_power_label.add_theme_font_size_override("font_size", 24 if portrait else 14)
	_power_label.visible = true
	_pause_button.add_theme_font_size_override("font_size", 27 if portrait else 17)
	_pause_button.custom_minimum_size = Vector2(160.0, 72.0) if portrait else Vector2(104.0, 40.0)
	_touch_controls.scale = Vector2.ONE * (1.5 if portrait else 1.0)
	_touch_controls.position = Vector2(30.0, size.y - 290.0) if portrait else Vector2(20.0, size.y - 198.0)
	_skip_tutorial_button.custom_minimum_size = Vector2(260.0, 80.0) if portrait else Vector2(170.0, 46.0)
	_skip_tutorial_button.add_theme_font_size_override("font_size", 24 if portrait else 15)
	_skip_tutorial_button.position = Vector2(size.x - (290.0 if portrait else 205.0), size.y - (185.0 if portrait else 125.0))


func _fit_centered(control: Control, design_size: Vector2, maximum_scale: float) -> void:
	control.set_anchors_preset(Control.PRESET_TOP_LEFT)
	control.size = design_size.max(control.get_combined_minimum_size())
	var fit := minf(maximum_scale, minf((size.x - 48.0) / control.size.x, (size.y - 60.0) / control.size.y))
	control.pivot_offset = control.size * 0.5
	control.scale = Vector2.ONE * fit
	control.set_meta("fit_scale", control.scale)
	control.position = (size - control.size) * 0.5


func _apply_filter_settings() -> void:
	if _filter == null:
		return
	_filter.visible = bool(TuningStore.get_value("environment.filter.enabled", true))
	_filter_material.set_shader_parameter("strength", float(TuningStore.get_value("environment.filter.intensity", 0.18)))
	if _hud != null:
		_hud.modulate.a = float(TuningStore.get_value("ui.hud.opacity", 0.94))


func _on_tuning_value_changed(key: String, _requested: Variant, _active: Variant) -> void:
	if key in ["environment.filter.enabled", "environment.filter.intensity", "ui.hud.opacity"]:
		_apply_filter_settings()
	if key == "environment.camera.zoom":
		_layout_world()


func _on_locale_changed(_locale: String) -> void:
	_refresh_texts()
	if _screen == "leaderboard":
		_refresh_leaderboard_rows()


func _refresh_texts() -> void:
	_title_label.text = I18n.text("app.title")
	_subtitle_label.text = I18n.text("app.subtitle")
	_tagline_label.text = I18n.text("app.tagline")
	_play_button.text = I18n.text("menu.play")
	_licenses_button.text = I18n.text("ui.open_source_licenses")
	_skip_tutorial_button.text = I18n.t("tutorial.skip")
	_leaderboard_button.text = I18n.text("menu.leaderboard")
	_language_button.text = I18n.text("menu.language")
	_tutorial_button.text = I18n.text("menu.tutorial_replay")
	_pause_button.text = I18n.text("hud.pause")
	_pause_title.text = I18n.text("pause.title")
	_resume_button.text = I18n.text("pause.resume")
	_restart_button.text = I18n.text("pause.restart")
	_pause_title_button.text = I18n.text("pause.main_menu")
	_confirm_title.text = I18n.t("confirm.heading")
	_confirm_accept_button.text = I18n.t("confirm.accept")
	_confirm_cancel_button.text = I18n.t("confirm.cancel")
	if not _pending_destructive_action.is_empty():
		_confirm_message.text = I18n.t("confirm.%s" % _pending_destructive_action)
	_result_name_label.text = I18n.text("result.name").to_upper()
	_name_input.placeholder_text = I18n.text("result.name_placeholder")
	_submit_button.text = I18n.text("result.submit")
	_play_again_button.text = I18n.text("result.play_again")
	_result_title_button.text = I18n.text("result.main_menu")
	for node: Node in _result_screen.find_children("*", "Button", true, false):
		if node.has_meta("locale_key"):
			(node as Button).text = I18n.text(str(node.get_meta("locale_key")))
	_leaderboard_title.text = I18n.text("leaderboard.title")
	_leaderboard_back_button.text = I18n.text("leaderboard.back")
	if _screen == "result":
		_refresh_result_texts()
	if _world != null:
		_on_stats_changed(_run_score, _run_lives)
		_on_effects_changed(_world.get_active_effects())
	_refresh_game_ui_texts()


## Menu items read as game menus (Latin caps; CJK unaffected); key prompts follow the locale.
func _refresh_game_ui_texts() -> void:
	for menu: VBoxContainer in [_title_menu, _pause_menu]:
		for node: Node in menu.get_children():
			if node is Button:
				(node as Button).text = (node as Button).text.to_upper()
	for node: Node in find_children("*", "HBoxContainer", true, false):
		if node.has_meta("locale_key") and node.has_node("Action"):
			(node.get_node("Action") as Label).text = I18n.text(str(node.get_meta("locale_key")))


func _refresh_result_texts() -> void:
	_result_title.text = I18n.text("result.victory" if _run_completed else "result.game_over")
	var score_parts := _stat_parts("result.score", "score", str(roundi(float(_run_score) * _result_reveal)))
	_result_score_caption.text = score_parts[0].to_upper()
	_result_score.text = score_parts[1]
	_result_time.text = I18n.text("result.time", {"time": "%.1f" % _run_elapsed})
	_result_name_label.text = I18n.text("result.name").to_upper()
	_name_input.placeholder_text = I18n.text("result.name_placeholder")
	_submit_button.text = I18n.text("result.submit")
	_play_again_button.text = I18n.text("result.play_again")
	_result_title_button.text = I18n.text("result.main_menu")
	if _score_saved:
		_result_status.text = I18n.t("result.saved_local")
	elif not _run_result.is_empty() and not bool(_run_result.get("ranked_eligible", false)):
		_result_status.text = I18n.t("result.unranked", {"marker": str(_run_result.get("configuration_marker", ""))})


func _clear_world() -> void:
	if _world != null and is_instance_valid(_world):
		_world.queue_free()
	_world = null
