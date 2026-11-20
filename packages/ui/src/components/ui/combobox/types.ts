/** task-152：>8 项选择器的选项形状（SearchableCombobox 用）。 */
export interface SearchableComboboxOption {
    /** 不能是空串：reka 用空串表示「清空选择」。 */
    value: string;
    label: string;
    /** 右侧次要说明（如域名的中文名），只展示不参与搜索。 */
    hint?: string;
}
