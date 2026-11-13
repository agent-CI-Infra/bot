function schedulesSection() {
  const section=element('section'),id=current.id;
  void renderSchedules(section,id).catch(error=>{if(section.isConnected)section.replaceChildren(note('计划暂不可读取：'+error.message));});
  return [section];
}
